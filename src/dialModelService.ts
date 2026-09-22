import * as vscode from 'vscode';
import { readTemperatureFromIdeOptions } from './chatRequestBuilder';
import {
	buildW3CTraceRequestHeaders,
	readOtelTraceContextFromModelOptions,
	w3cTraceHeadersToHttp,
} from './w3cTraceContext';
import { DialClient } from './dialClient';
import { type CredentialStore } from './credentialStore';
import {
	filterByRequiredTopics,
	logTopicFilterDiagnostics,
	partitionByKind,
	summarizeModelPipeline,
	topicsEqual,
} from './deploymentFilter';
import { dialLog } from './logger';
import { summarizeAccessToken, summarizeAccessTokenClaims } from './jwtUtils';
import { toDialMessages, toOpenAITools, toToolChoice } from './messageConversion';
import { reportStreamUsage } from './usageReporting';
import {
	type Credential,
	type DialChatRequest,
	type DialConfig,
	type DialDeployment,
	type Nullable,
	type OpenAIStreamUsage,
} from './types';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** Refetch listing when the picker opens and the cache is older than this. */
const PICKER_STALE_MS = 60_000;

/**
 * Reactive model service.
 *
 * Constructor is synchronous — subscribes to {@link CredentialStore.onDidChange}.
 * When credentials arrive → fetches deployments from DIAL and emits
 * {@link onDidChangeModels}. Also refreshes models on a periodic timer.
 */
export class DialModelService implements vscode.Disposable {
	private readonly _onDidChangeModels = new vscode.EventEmitter<void>();
	readonly onDidChangeModels = this._onDidChangeModels.event;

	private client: Nullable<DialClient>;
	/** Unfiltered listing from DIAL (before topic / kind filters). */
	private _sourceModels: readonly DialDeployment[] = [];
	private _models: readonly DialDeployment[] = [];
	private lastFetchCompletedAt = 0;
	private timer: Nullable<ReturnType<typeof setInterval>>;
	private fetchInFlight: Nullable<Promise<void>>;
	private readonly subs: vscode.Disposable[] = [];
	private readonly credentialStore: CredentialStore;
	private config: DialConfig;

	constructor(credentialStore: CredentialStore, config: DialConfig) {
		this.credentialStore = credentialStore;
		this.config = config;
		this.subs.push(credentialStore.onDidChange((c) => this.onCredential(c)));
	}

	/** Current available models/deployments (empty until auth succeeds). */
	get models(): readonly DialDeployment[] {
		return this._models;
	}

	/**
	 * Apply a new config snapshot. Topic filter changes reprocess the cached
	 * listing immediately; server/auth changes refetch.
	 */
	updateConfig(next: DialConfig): void {
		const topicsChanged = !topicsEqual(this.config.requiredTopics, next.requiredTopics);
		const serverChanged =
			this.config.serverUrl !== next.serverUrl || this.config.authMethod !== next.authMethod;
		this.config = next;

		if (serverChanged) {
			const cred = this.credentialStore.current;
			if (cred) {
				this.client = new DialClient(this.config, cred.token);
				void this.fetchModels();
			}
			return;
		}

		if (topicsChanged) {
			if (this._sourceModels.length > 0) {
				this.applyCachedModels();
			} else if (this.client) {
				void this.fetchModels();
			}
		}
	}

	/** Start or refresh deployment fetch when the picker needs an up-to-date list. */
	ensureModelsLoaded(): void {
		if (!this.credentialStore.current || !this.client) {
			return;
		}
		if (this._sourceModels.length === 0) {
			void this.fetchModels();
			return;
		}
		if (Date.now() - this.lastFetchCompletedAt >= PICKER_STALE_MS) {
			void this.fetchModels();
		}
	}

	/**
	 * Returns a promise that resolves with the model count once the next
	 * {@link onDidChangeModels} fires (or on timeout).
	 */
	awaitModelUpdate(timeoutMs = 15_000): Promise<number> {
		return new Promise<number>((resolve) => {
			let settled = false;
			const done = (n: number): void => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				sub.dispose();
				resolve(n);
			};
			const sub = this._onDidChangeModels.event(() => done(this._models.length));
			const timer = setTimeout(() => done(this._models.length), timeoutMs);
		});
	}

	async streamChat(
		deploymentId: string,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const client = this.client;
		if (!client) {
			const msg = 'DIAL: not authenticated — run "DIAL: Login" first';
			dialLog.error(msg);
			throw new Error(msg);
		}

		const accessToken = await this.credentialStore.ensureValidToken();
		client.updateAuthToken(accessToken);

		if (this.config.authMethod === 'openid') {
			dialLog.info(
				`streamChat auth id=${deploymentId}`,
				summarizeAccessToken(accessToken),
				summarizeAccessTokenClaims(accessToken),
			);
		}

		let deployment: Nullable<DialDeployment> = this._models.find((m) => m.id === deploymentId);
		if (!deployment) {
			try {
				deployment = await client.getDeployment(deploymentId);
				dialLog.info(`Fetched deployment metadata for ${deploymentId}`);
			} catch (e: unknown) {
				const detail = e instanceof Error ? e.message : String(e);
				dialLog.warn(`Could not fetch deployment metadata for ${deploymentId}: ${detail}`);
			}
		}

		const tools = toOpenAITools(options.tools);
		const hasTools = (tools?.length ?? 0) > 0;
		const toolChoice = toToolChoice(options.toolMode, hasTools);
		let resolvedForMessages: DialDeployment;
		if (deployment) {
			resolvedForMessages = deployment;
		} else {
			dialLog.warn(
				`Deployment metadata unavailable for ${deploymentId}; ` +
					'attachments will be rejected (only text will be forwarded).',
			);
			resolvedForMessages = { id: deploymentId, model: deploymentId };
		}
		const hostOptions = options as vscode.ProvideLanguageModelChatResponseOptions & {
			readonly modelConfiguration?: { readonly [key: string]: unknown };
		};
		const temperature = readTemperatureFromIdeOptions(
			options.modelOptions,
			hostOptions.modelConfiguration,
		);
		const request: DialChatRequest = {
			messages: toDialMessages(messages, resolvedForMessages),
			...(tools !== undefined ? { tools } : {}),
			...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
			...(temperature !== undefined ? { temperature } : {}),
		};

		const traceHeaders = w3cTraceHeadersToHttp(
			buildW3CTraceRequestHeaders(readOtelTraceContextFromModelOptions(options.modelOptions)),
		);

		dialLog.info(`streamChat start id=${deploymentId}`, {
			messageCount: request.messages.length,
			toolCount: request.tools?.length ?? 0,
			w3cTraceContext: traceHeaders !== undefined,
		});

		const abort = new AbortController();
		const cancelSub = token.onCancellationRequested(() => abort.abort());
		let lastUsage: OpenAIStreamUsage | undefined;
		try {
			await client.streamChatCompletion(
				deploymentId,
				request,
				{
					onText: (chunk) => progress.report(new vscode.LanguageModelTextPart(chunk)),
					onToolCall: (callId, name, input) =>
						progress.report(new vscode.LanguageModelToolCallPart(callId, name, input)),
					onUsage: (usage) => {
						lastUsage = usage;
					},
				},
				deployment,
				{
					signal: abort.signal,
					...(traceHeaders !== undefined ? { traceHeaders } : {}),
				},
			);
			if (lastUsage) {
				reportStreamUsage(progress, lastUsage);
				dialLog.info(`streamChat usage reported id=${deploymentId}`, {
					prompt_tokens: lastUsage.prompt_tokens,
					completion_tokens: lastUsage.completion_tokens,
					total_tokens: lastUsage.total_tokens,
				});
			} else {
				dialLog.warn(
					`streamChat finished without usage id=${deploymentId} — Chat context counters may stay at 0. ` +
						'Check upstream supports stream_options.include_usage on the final SSE chunk.',
				);
			}
		} catch (e: unknown) {
			const detail = e instanceof Error ? e.message : String(e);
			dialLog.error(`streamChat failed id=${deploymentId}`, detail);
			throw new Error(appendDialSessionHint(detail));
		} finally {
			cancelSub.dispose();
		}
	}

	dispose(): void {
		this.stopTimer();
		this._onDidChangeModels.dispose();
		for (const d of this.subs) {
			d.dispose();
		}
	}

	// ── Private ──────────────────────────────────────────────

	private onCredential(cred: Nullable<Credential>): void {
		this.stopTimer();

		if (!cred || !this.config.serverUrl) {
			dialLog.info(
				'Model service: credentials cleared or serverUrl missing',
				`hasCred=${Boolean(cred)}`,
				`serverUrl=${this.config.serverUrl || '(empty)'}`,
			);
			this.client = undefined;
			this._sourceModels = [];
			this._models = [];
			this.lastFetchCompletedAt = 0;
			this._onDidChangeModels.fire();
			return;
		}

		dialLog.info(
			'Model service: credentials received — fetching models',
			`authMethod=${cred.method}`,
			`serverUrl=${this.config.serverUrl}`,
			`requiredTopics=${(this.config.requiredTopics ?? []).join(', ') || '(none)'}`,
		);
		this.client = new DialClient(this.config, cred.token);
		void this.fetchModels();
		this.startTimer();
	}

	private fetchModels(): Promise<void> {
		const client = this.client;
		if (!client) {
			dialLog.warn('Model fetch skipped — DialClient not initialized');
			return Promise.resolve();
		}

		if (this.fetchInFlight) {
			return this.fetchInFlight;
		}

		const run = this.runFetchModels(client);
		this.fetchInFlight = run;
		return run.finally(() => {
			if (this.fetchInFlight === run) {
				this.fetchInFlight = undefined;
			}
		});
	}

	private async runFetchModels(client: DialClient): Promise<void> {
		dialLog.info(
			'Model fetch started',
			`requiredTopics=${(this.config.requiredTopics ?? []).join(', ') || '(none)'}`,
		);
		try {
			const token = await this.credentialStore.ensureValidToken();
			client.updateAuthToken(token);
			this._sourceModels = await client.getModels();
			this.lastFetchCompletedAt = Date.now();
			this.applyCachedModels();
		} catch (e: unknown) {
			const detail = e instanceof Error ? e.message : String(e);
			dialLog.error('Model fetch failed', detail);
			if (isDialSessionExpired(detail)) {
				this._sourceModels = [];
				this._models = [];
				this._onDidChangeModels.fire();
			} else if (isDialAuthFailure(detail)) {
				await this.credentialStore.invalidateSession();
				this._sourceModels = [];
				this._models = [];
				this._onDidChangeModels.fire();
			}
			// Transient errors keep the previous picker list.
		}
	}

	private applyCachedModels(): void {
		const requiredTopics = this.config.requiredTopics ?? [];
		const filtered = filterByRequiredTopics(this._sourceModels, requiredTopics);
		const partitioned = partitionByKind(filtered);
		dialLog.info(
			summarizeModelPipeline(this._sourceModels.length, filtered.length, partitioned),
		);
		logTopicFilterDiagnostics(this._sourceModels, requiredTopics, filtered, partitioned);
		this._models = partitioned.chat;
		dialLog.info(
			`Chat models for picker: ${
				this._models.length > 0 ? this._models.map((m) => m.id).join(', ') : '(none)'
			}`,
		);
		if (partitioned.embedding.length > 0) {
			dialLog.info(
				`Embedding models excluded from chat picker: ${partitioned.embedding
					.map((m) => m.id)
					.join(', ')}`,
			);
		}
		this._onDidChangeModels.fire();
	}

	private startTimer(): void {
		this.timer = setInterval(() => {
			void this.fetchModels();
		}, REFRESH_INTERVAL_MS);
	}

	private stopTimer(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}

function isDialSessionExpired(detail: string): boolean {
	return detail.includes('DIAL session expired');
}

function isDialAuthFailure(detail: string): boolean {
	const lower = detail.toLowerCase();
	return lower.includes('http 401') || lower.includes('unknown api key');
}

function appendDialSessionHint(detail: string): string {
	if (isDialAuthFailure(detail) || detail.includes('user bucket')) {
		return `${detail} — try "DIAL: Login" to refresh your session`;
	}
	return detail;
}
