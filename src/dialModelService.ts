import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { DialClient } from './dialClient';
import { type CredentialStore } from './credentialStore';
import { dialLog } from './logger';
import { summarizeAccessToken, summarizeAccessTokenClaims } from './jwtUtils';
import {
	flattenRequestMessageText,
	toDialMessages,
	toOpenAITools,
	toToolChoice,
} from './messageConversion';
import { isTokenizeUnavailableError, isRetryableTokenizeError } from './tokenization';
import { abortError, isAbortError } from './cancel';
import { retryWithBackoff } from './retry';
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
/** Upper bound on cached token counts; the IDE re-counts every message each turn. */
const TOKENIZE_CACHE_MAX = 1000;

export interface ModelListChange {
	readonly models: readonly DialDeployment[];
	readonly added: readonly string[];
	readonly removed: readonly string[];
}

export interface DialModelServiceOptions {
	/** When false, skips silent restore fetches and the periodic refresh timer (used in VS Code test runs). */
	readonly backgroundSync?: boolean;
}

/**
 * Reactive model service.
 *
 * Constructor is synchronous — subscribes to {@link CredentialStore.onDidChange}.
 * When credentials arrive → fetches deployments from DIAL and emits
 * {@link onDidChangeModels}. Also refreshes models on a periodic timer.
 */
export class DialModelService implements vscode.Disposable {
	private readonly _onDidChangeModels = new vscode.EventEmitter<ModelListChange>();
	readonly onDidChangeModels = this._onDidChangeModels.event;

	private client: Nullable<DialClient>;
	private _models: readonly DialDeployment[] = [];
	private timer: Nullable<ReturnType<typeof setInterval>>;
	private fetchInFlight: Nullable<Promise<void>>;
	private readonly subs: vscode.Disposable[] = [];
	private readonly credentialStore: CredentialStore;
	private readonly config: DialConfig;
	private readonly backgroundSync: boolean;
	/** Deployments whose tokenize endpoint is missing (HTTP 404) — fail fast for the session. */
	private readonly tokenizeUnavailable = new Set<string>();
	/** Deployments for which a successful tokenize call has already been logged once. */
	private readonly tokenizeLogged = new Set<string>();
	/** Bounded cache of token counts keyed by deployment + content hash (counts are deterministic). */
	private readonly tokenizeCache = new Map<string, number>();
	/** In-flight tokenize calls keyed by cache key — coalesce concurrent identical requests. */
	private readonly tokenizeInFlight = new Map<string, Promise<number>>();

	constructor(
		credentialStore: CredentialStore,
		config: DialConfig,
		options?: DialModelServiceOptions,
	) {
		this.credentialStore = credentialStore;
		this.config = config;
		this.backgroundSync = options?.backgroundSync !== false;
		this.subs.push(credentialStore.onDidChange((c) => this.onCredential(c)));
	}

	/** Current available models/deployments (empty until auth succeeds). */
	get models(): readonly DialDeployment[] {
		return this._models;
	}

	/** Waits for the current model fetch (starting one if needed), then returns the count. */
	async awaitModelUpdate(timeoutMs = 15_000): Promise<number> {
		await Promise.race([
			this.fetchModels(),
			new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
		]);
		return this._models.length;
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
		const cancelSub = token.onCancellationRequested(() => {
			dialLog.info(`streamChat cancel requested id=${deploymentId}`);
			abort.abort();
		});
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
				{ signal: abort.signal },
			);
			if (lastUsage) {
				reportStreamUsage(progress, lastUsage);
				dialLog.info(`streamChat usage id=${deploymentId}`, {
					prompt_tokens: lastUsage.prompt_tokens,
					completion_tokens: lastUsage.completion_tokens,
					total_tokens: lastUsage.total_tokens,
				});
			}
		} catch (e: unknown) {
			if (isAbortError(e)) {
				dialLog.info(`streamChat cancelled id=${deploymentId}`);
				throw e;
			}
			const detail = e instanceof Error ? e.message : String(e);
			dialLog.error(`streamChat failed id=${deploymentId}`, detail);
			throw new Error(appendDialSessionHint(detail));
		} finally {
			cancelSub.dispose();
		}
	}

	/**
	 * Count tokens for a string or single chat message via the DIAL tokenize endpoint.
	 *
	 * Results are served from a SHA-1 content cache. Uncached calls hit the API once
	 * (concurrent identical inputs share one in-flight request) and retry transient
	 * failures with exponential backoff (`dial.httpRetry*` settings).
	 */
	async countTokens(
		deploymentId: string,
		text: string | vscode.LanguageModelChatRequestMessage,
		token: vscode.CancellationToken,
	): Promise<number> {
		if (token.isCancellationRequested) {
			throw abortError('Token count cancelled');
		}

		const input = typeof text === 'string' ? text : flattenRequestMessageText(text);
		if (input.length === 0) {
			return 0;
		}

		if (!this.config.useServerTokenization) {
			throw new Error(
				'DIAL: server tokenization is disabled — set dial.useServerTokenization to true',
			);
		}

		const client = this.client;
		if (!client) {
			throw new Error('DIAL: not authenticated — run "DIAL: Login" first');
		}

		if (this.tokenizeUnavailable.has(deploymentId)) {
			throw new Error(`DIAL: tokenize endpoint unavailable for ${deploymentId}`);
		}

		const cacheKey = this.tokenizeCacheKey(deploymentId, input);
		const cached = this.tokenizeCache.get(cacheKey);
		if (cached !== undefined) {
			return cached;
		}

		const inflight = this.tokenizeInFlight.get(cacheKey);
		if (inflight) {
			return inflight;
		}

		const work = this.fetchTokenCount(deploymentId, input, cacheKey, client, token);
		this.tokenizeInFlight.set(cacheKey, work);
		try {
			return await work;
		} finally {
			this.tokenizeInFlight.delete(cacheKey);
		}
	}

	private async fetchTokenCount(
		deploymentId: string,
		input: string,
		cacheKey: string,
		client: DialClient,
		token: vscode.CancellationToken,
	): Promise<number> {
		const abort = new AbortController();
		const cancelSub = token.onCancellationRequested(() => abort.abort());

		try {
			return await retryWithBackoff(
				async () => {
					if (token.isCancellationRequested) {
						throw abortError('Token count cancelled');
					}
					const accessToken = await this.credentialStore.ensureValidToken();
					client.updateAuthToken(accessToken);
					const results = await client.tokenize(deploymentId, [input], {
						signal: abort.signal,
					});
					const result = results[0];
					if (result?.error) {
						throw new Error(`Tokenize error: ${result.error}`);
					}
					if (result?.tokenCount === undefined) {
						throw new Error('Tokenize response missing token_count');
					}
					this.cacheTokenCount(cacheKey, result.tokenCount);
					if (!this.tokenizeLogged.has(deploymentId)) {
						this.tokenizeLogged.add(deploymentId);
						dialLog.info(`Tokenize endpoint active for ${deploymentId}`);
					}
					return result.tokenCount;
				},
				{
					...this.config.httpRetry,
					signal: abort.signal,
					isRetryable: isRetryableTokenizeError,
					onRetry: (attempt, delayMs, detail) => {
						dialLog.warn(
							`Tokenize retry ${deploymentId} attempt=${attempt}/${this.config.httpRetry.maxAttempts} delayMs=${delayMs}`,
							detail,
						);
					},
				},
			);
		} catch (e: unknown) {
			const detail = e instanceof Error ? e.message : String(e);
			if (isTokenizeUnavailableError(detail)) {
				this.tokenizeUnavailable.add(deploymentId);
				dialLog.warn(`Tokenize endpoint unavailable for ${deploymentId}`, detail);
			}
			dialLog.error(`Tokenize failed for ${deploymentId}`, detail);
			throw e instanceof Error ? e : new Error(detail);
		} finally {
			cancelSub.dispose();
		}
	}

	private tokenizeCacheKey(deploymentId: string, input: string): string {
		const hash = createHash('sha1').update(input).digest('base64');
		return `${deploymentId}\u0000${hash}`;
	}

	private cacheTokenCount(key: string, count: number): void {
		this.tokenizeCache.set(key, count);
		if (this.tokenizeCache.size > TOKENIZE_CACHE_MAX) {
			const oldest = this.tokenizeCache.keys().next().value;
			if (oldest !== undefined) {
				this.tokenizeCache.delete(oldest);
			}
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
			this.publishModelList([], this._models.map((m) => m.id));
			return;
		}

		dialLog.info(
			'Model service: credentials received — fetching deployments',
			`authMethod=${cred.method}`,
			`serverUrl=${this.config.serverUrl}`,
		);
		this.client = new DialClient(this.config, cred.token);
		if (!this.backgroundSync) {
			return;
		}
		void this.fetchModels();
		this.startTimer();
	}

	private fetchModels(): Promise<void> {
		if (!this.backgroundSync) {
			return Promise.resolve();
		}
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
		const previousIds = this._models.map((m) => m.id);
		try {
			const token = await this.credentialStore.ensureValidToken();
			client.updateAuthToken(token);
			const nextModels = await client.getDeployments();
			dialLog.info(
				`Model fetch completed — ${nextModels.length} deployment(s) cached for model picker`,
				nextModels.length > 0
					? nextModels.map((m) => m.id).join(', ')
					: '(none — Copilot model picker will be empty)',
			);
			this.publishModelList(nextModels, previousIds);
		} catch (e: unknown) {
			const detail = e instanceof Error ? e.message : String(e);
			dialLog.error('Model fetch failed', detail);
			if (isDialSessionExpired(detail)) {
				this.publishModelList([], previousIds);
			} else if (isDialAuthFailure(detail)) {
				await this.credentialStore.invalidateSession();
				this.publishModelList([], previousIds);
			} else {
				// Tell the model picker the load attempt finished (avoids endless init wait).
				this.publishModelList(this._models, previousIds);
			}
		}
	}

	/** Start a deployment fetch when the picker has no cached models but credentials exist. */
	ensureModelsLoaded(): void {
		if (!this.backgroundSync) {
			return;
		}
		if (this._models.length > 0 || !this.credentialStore.current || !this.client) {
			return;
		}
		void this.fetchModels();
	}

	private publishModelList(
		models: readonly DialDeployment[],
		previousIds: readonly string[],
	): void {
		const previousSet = new Set(previousIds);
		const nextSet = new Set(models.map((m) => m.id));
		const added = models.filter((m) => !previousSet.has(m.id)).map((m) => m.id);
		const removed = previousIds.filter((id) => !nextSet.has(id));
		const portfolioChanged =
			added.length > 0 ||
			removed.length > 0 ||
			models.length !== previousIds.length;

		this._models = models;

		// VS Code waits for onDidChangeLanguageModelChatInformation after an empty first
		// response — notify on first load / after clear even when the list is still empty.
		const shouldNotifyPicker = portfolioChanged || previousIds.length === 0;
		if (!shouldNotifyPicker) {
			dialLog.info('Model fetch — list unchanged, skipping model picker refresh');
			return;
		}

		if (portfolioChanged) {
			dialLog.info(
				'Model list changed',
				added.length > 0 ? `added=${added.join(', ')}` : '',
				removed.length > 0 ? `removed=${removed.join(', ')}` : '',
			);
		} else {
			dialLog.info(
				`Model fetch — picker refresh (${models.length} deployment(s), unchanged IDs)`,
			);
		}

		this._onDidChangeModels.fire({ models, added, removed });
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
