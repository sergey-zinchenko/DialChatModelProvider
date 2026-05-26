import * as vscode from 'vscode';
import { DialClient } from './dialClient';
import { type CredentialStore } from './credentialStore';
import { dialLog } from './logger';
import { summarizeAccessToken, summarizeAccessTokenClaims } from './jwtUtils';
import { toDialMessages, toOpenAITools, toToolChoice } from './messageConversion';
import {
	type Credential,
	type DialChatRequest,
	type DialConfig,
	type DialDeployment,
	type Nullable,
} from './types';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

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
	private _models: readonly DialDeployment[] = [];
	private timer: Nullable<ReturnType<typeof setInterval>>;
	private fetchInFlight: Nullable<Promise<void>>;
	private readonly subs: vscode.Disposable[] = [];
	private readonly credentialStore: CredentialStore;
	private readonly config: DialConfig;

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
		const request: DialChatRequest = {
			messages: toDialMessages(messages, resolvedForMessages),
			...(tools !== undefined ? { tools } : {}),
			...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
		};

		dialLog.info(`streamChat start id=${deploymentId}`, {
			messageCount: request.messages.length,
			toolCount: request.tools?.length ?? 0,
		});

		const abort = new AbortController();
		const cancelSub = token.onCancellationRequested(() => abort.abort());
		try {
			await client.streamChatCompletion(
				deploymentId,
				request,
				{
					onText: (chunk) => progress.report(new vscode.LanguageModelTextPart(chunk)),
					onToolCall: (callId, name, input) =>
						progress.report(new vscode.LanguageModelToolCallPart(callId, name, input)),
				},
				deployment,
				{ signal: abort.signal },
			);
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
			this._models = [];
			this._onDidChangeModels.fire();
			return;
		}

		dialLog.info(
			'Model service: credentials received — fetching deployments',
			`authMethod=${cred.method}`,
			`serverUrl=${this.config.serverUrl}`,
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
		dialLog.info('Model fetch started');
		try {
			const token = await this.credentialStore.ensureValidToken();
			client.updateAuthToken(token);
			this._models = await client.getDeployments();
			dialLog.info(
				`Model fetch completed — ${this._models.length} deployment(s) cached for model picker`,
				this._models.length > 0
					? this._models.map((m) => m.id).join(', ')
					: '(none — Copilot model picker will be empty)',
			);
		} catch (e: unknown) {
			const detail = e instanceof Error ? e.message : String(e);
			dialLog.error('Model fetch failed', detail);
			if (isDialSessionExpired(detail)) {
				this._models = [];
			} else if (isDialAuthFailure(detail)) {
				await this.credentialStore.invalidateSession();
				this._models = [];
			}
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
