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
import { heuristicTokenCount, isTokenizeUnavailableError, TokenBucket } from './tokenization';
import {
	type Credential,
	type DialChatRequest,
	type DialConfig,
	type DialDeployment,
	type Nullable,
} from './types';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** Backoff window after a transient tokenize failure before retrying the endpoint. */
const TOKENIZE_COOLDOWN_MS = 60 * 1000;
/** Upper bound on cached token counts; the IDE re-counts every message each turn. */
const TOKENIZE_CACHE_MAX = 1000;
/** Throttle window for the aggregated tokenize stats log line. */
const TOKENIZE_STATS_LOG_INTERVAL_MS = 5_000;

interface TokenizeStats {
	counts: number;
	tokens: number;
	parseMiss: number;
	budgetSkipped: number;
	lastLogAt: number;
}
/** Coalescing window: batch all tokenize calls that arrive within this gap into one request. */
const TOKENIZE_BATCH_DEBOUNCE_MS = 10;
/** Max inputs per tokenize request; larger flushes are split into several requests. */
const TOKENIZE_BATCH_MAX = 64;

interface PendingTokenize {
	readonly input: string;
	readonly cacheKey: string;
	readonly fallback: number;
	readonly token: vscode.CancellationToken;
	readonly resolve: (count: number) => void;
}

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
	/** Deployments whose tokenize endpoint is missing (HTTP 404) — heuristic for the session. */
	private readonly tokenizeUnavailable = new Set<string>();
	/** Deployments for which a successful tokenize call has already been logged once. */
	private readonly tokenizeLogged = new Set<string>();
	/** Per-deployment backoff after a transient tokenize failure (epoch ms until retry). */
	private readonly tokenizeCooldownUntil = new Map<string, number>();
	/** Deployments whose transient tokenize failure has already been warned once. */
	private readonly tokenizeWarned = new Set<string>();
	/** Bounded cache of token counts keyed by deployment + content hash (counts are deterministic). */
	private readonly tokenizeCache = new Map<string, number>();
	/** Aggregated tokenize stats per deployment (logged on a throttle, not per call). */
	private readonly tokenizeStats = new Map<string, TokenizeStats>();
	/** Pending tokenize calls per deployment, flushed together as one batch request. */
	private readonly tokenizeQueue = new Map<string, PendingTokenize[]>();
	/** Scheduled batch-flush timers per deployment. */
	private readonly tokenizeFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/**
	 * Rate limiter for outbound `/tokenize` requests (shared across deployments —
	 * the ingress limit is per client IP). Protects chat completions on the same
	 * limit; when empty, token counts fall back to the heuristic. `null` disables
	 * server tokenization entirely (`tokenizeRequestsPerMinute = 0`).
	 */
	private readonly tokenizeLimiter: Nullable<TokenBucket>;

	constructor(credentialStore: CredentialStore, config: DialConfig) {
		this.credentialStore = credentialStore;
		this.config = config;
		const rpm = config.tokenizeRequestsPerMinute;
		// Burst is capped so a fresh prompt cannot drain the whole per-minute budget at once.
		this.tokenizeLimiter = rpm > 0 ? new TokenBucket(Math.min(rpm, 10), rpm) : undefined;
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

	/**
	 * Count tokens for a string or single chat message via the DIAL tokenize endpoint,
	 * falling back to a length-based heuristic when the deployment has no tokenizer,
	 * the call fails, or the request is cancelled.
	 *
	 * `provideTokenCount` is invoked once per message while the IDE composes a prompt,
	 * which would otherwise burst the upstream rate limiter (HTTP 503). To stay under
	 * it, calls are (1) served from a per-content cache, then (2) coalesced into a
	 * single batched tokenize request. Failures are damped: a missing route (HTTP 404)
	 * disables tokenize for the session; any other failure (e.g. HTTP 503) opens a
	 * short cooldown during which the heuristic is returned silently, logged once.
	 */
	async countTokens(
		deploymentId: string,
		text: string | vscode.LanguageModelChatRequestMessage,
		token: vscode.CancellationToken,
	): Promise<number> {
		const input = typeof text === 'string' ? text : flattenRequestMessageText(text);
		const fallback = heuristicTokenCount(input);

		if (
			!this.client ||
			!this.tokenizeLimiter ||
			input.length === 0 ||
			this.tokenizeUnavailable.has(deploymentId)
		) {
			return fallback;
		}

		const cacheKey = this.tokenizeCacheKey(deploymentId, input);
		const cached = this.tokenizeCache.get(cacheKey);
		if (cached !== undefined) {
			return cached;
		}

		const cooldownUntil = this.tokenizeCooldownUntil.get(deploymentId);
		if (cooldownUntil !== undefined && Date.now() < cooldownUntil) {
			return fallback;
		}

		return new Promise<number>((resolve) => {
			this.enqueueTokenize(deploymentId, { input, cacheKey, fallback, token, resolve });
		});
	}

	private enqueueTokenize(deploymentId: string, item: PendingTokenize): void {
		const queue = this.tokenizeQueue.get(deploymentId);
		if (queue) {
			queue.push(item);
		} else {
			this.tokenizeQueue.set(deploymentId, [item]);
		}
		if (!this.tokenizeFlushTimers.has(deploymentId)) {
			const timer = setTimeout(() => {
				void this.flushTokenize(deploymentId);
			}, TOKENIZE_BATCH_DEBOUNCE_MS);
			this.tokenizeFlushTimers.set(deploymentId, timer);
		}
	}

	private async flushTokenize(deploymentId: string): Promise<void> {
		this.tokenizeFlushTimers.delete(deploymentId);
		const items = this.tokenizeQueue.get(deploymentId) ?? [];
		this.tokenizeQueue.delete(deploymentId);
		if (items.length === 0) {
			return;
		}

		// Cancelled calls and a re-checked cooldown short-circuit to the heuristic.
		const cooldownUntil = this.tokenizeCooldownUntil.get(deploymentId);
		const paused =
			!this.client ||
			this.tokenizeUnavailable.has(deploymentId) ||
			(cooldownUntil !== undefined && Date.now() < cooldownUntil);

		// Deduplicate identical content within the batch; each unique key fans out to its waiters.
		const byKey = new Map<string, { readonly input: string; readonly waiters: PendingTokenize[] }>();
		for (const item of items) {
			if (paused || item.token.isCancellationRequested) {
				item.resolve(item.fallback);
				continue;
			}
			const existing = byKey.get(item.cacheKey);
			if (existing) {
				existing.waiters.push(item);
			} else {
				byKey.set(item.cacheKey, { input: item.input, waiters: [item] });
			}
		}
		if (byKey.size === 0) {
			return;
		}

		const client = this.client;
		if (!client) {
			for (const { waiters } of byKey.values()) {
				for (const w of waiters) {
					w.resolve(w.fallback);
				}
			}
			return;
		}

		const resolveKeysWithFallback = (resolveKeys: readonly string[]): void => {
			for (const key of resolveKeys) {
				for (const w of byKey.get(key)?.waiters ?? []) {
					w.resolve(w.fallback);
				}
			}
		};

		const keys = [...byKey.keys()];
		let tokenized = 0;
		let tokensSum = 0;
		let parseMiss = 0;
		let budgetSkipped = 0;
		try {
			const accessToken = await this.credentialStore.ensureValidToken();
			client.updateAuthToken(accessToken);
			for (let start = 0; start < keys.length; start += TOKENIZE_BATCH_MAX) {
				const chunkKeys = keys.slice(start, start + TOKENIZE_BATCH_MAX);
				// One token per HTTP request; when the rate budget is spent, fall back to
				// the heuristic for the rest so chat completions keep their share of the limit.
				if (this.tokenizeLimiter?.tryRemoveToken() !== true) {
					budgetSkipped = keys.length - start;
					resolveKeysWithFallback(keys.slice(start));
					break;
				}
				const chunkInputs = chunkKeys.map((k) => byKey.get(k)?.input ?? '');
				const results = await client.tokenize(deploymentId, chunkInputs);
				this.tokenizeCooldownUntil.delete(deploymentId);
				this.tokenizeWarned.delete(deploymentId);
				if (!this.tokenizeLogged.has(deploymentId)) {
					this.tokenizeLogged.add(deploymentId);
					dialLog.info(`Tokenize endpoint active for ${deploymentId}`);
				}
				chunkKeys.forEach((key, i) => {
					const waiters = byKey.get(key)?.waiters ?? [];
					const count = results[i]?.tokenCount;
					if (count !== undefined) {
						tokenized += 1;
						tokensSum += count;
						this.cacheTokenCount(key, count);
						for (const w of waiters) {
							w.resolve(count);
						}
					} else {
						parseMiss += 1;
						for (const w of waiters) {
							w.resolve(w.fallback);
						}
					}
				});
			}
			this.recordTokenizeStats(deploymentId, tokenized, tokensSum, parseMiss, budgetSkipped);
		} catch (e: unknown) {
			const detail = e instanceof Error ? e.message : String(e);
			if (isTokenizeUnavailableError(detail)) {
				this.tokenizeUnavailable.add(deploymentId);
				dialLog.warn(
					`Tokenize endpoint unavailable for ${deploymentId}; using heuristic token count for the session`,
					detail,
				);
			} else {
				this.tokenizeCooldownUntil.set(deploymentId, Date.now() + TOKENIZE_COOLDOWN_MS);
				if (!this.tokenizeWarned.has(deploymentId)) {
					this.tokenizeWarned.add(deploymentId);
					dialLog.warn(
						`Tokenize failed for ${deploymentId}; pausing tokenize for ${
							TOKENIZE_COOLDOWN_MS / 1000
						}s, using heuristic token count`,
						detail,
					);
				}
			}
			// Resolving an already-settled promise is a no-op, so successful chunks keep their value.
			for (const { waiters } of byKey.values()) {
				for (const w of waiters) {
					w.resolve(w.fallback);
				}
			}
		}
	}

	/** Accumulate tokenize stats and emit one aggregated log line per throttle window. */
	private recordTokenizeStats(
		deploymentId: string,
		tokenized: number,
		tokensSum: number,
		parseMiss: number,
		budgetSkipped: number,
	): void {
		const now = Date.now();
		const stats = this.tokenizeStats.get(deploymentId) ?? {
			counts: 0,
			tokens: 0,
			parseMiss: 0,
			budgetSkipped: 0,
			lastLogAt: now,
		};
		stats.counts += tokenized;
		stats.tokens += tokensSum;
		stats.parseMiss += parseMiss;
		stats.budgetSkipped += budgetSkipped;
		this.tokenizeStats.set(deploymentId, stats);

		// Flush a summary on the throttle window, or immediately if parsing failed.
		if (stats.parseMiss > 0 || now - stats.lastLogAt >= TOKENIZE_STATS_LOG_INTERVAL_MS) {
			dialLog.info(
				`Tokenize ${deploymentId}`,
				`counts=${stats.counts}`,
				`tokens=${stats.tokens}`,
				`parseMiss=${stats.parseMiss}`,
				`budgetSkipped=${stats.budgetSkipped}`,
			);
			this.tokenizeStats.set(deploymentId, {
				counts: 0,
				tokens: 0,
				parseMiss: 0,
				budgetSkipped: 0,
				lastLogAt: now,
			});
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
		for (const timer of this.tokenizeFlushTimers.values()) {
			clearTimeout(timer);
		}
		this.tokenizeFlushTimers.clear();
		for (const queue of this.tokenizeQueue.values()) {
			for (const item of queue) {
				item.resolve(item.fallback);
			}
		}
		this.tokenizeQueue.clear();
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
