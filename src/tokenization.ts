/**
 * Token counting helpers for the DIAL `/v1/deployments/{id}/tokenize` endpoint.
 *
 * The endpoint accepts a batch of `inputs` (plain strings or full chat requests)
 * and returns one `output` per input with a `token_count` or an `error`.
 * @see https://github.com/epam/ai-dial-sdk/blob/development/aidial_sdk/deployment/tokenize.py
 *
 * This module is intentionally free of `vscode` imports so it can be unit-tested
 * in isolation and reused by both the client (request shape) and the service.
 */

import { isRecord, readNumber, readString, type JsonValue } from './runtimeGuards';

/** Rough fallback when the deployment exposes no tokenizer (~4 chars/token). */
export function heuristicTokenCount(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	return Math.ceil(text.length / 4);
}

/**
 * Simple token-bucket rate limiter. The IDE asks for a token count once per
 * message, which would otherwise burst the DIAL ingress rate limiter (and starve
 * chat completions sharing the same per-IP limit). This caps tokenize calls to a
 * sustained `refillPerMinute` with an initial burst of `capacity`; callers fall
 * back to the heuristic when no token is available (no queueing / no delay).
 */
export class TokenBucket {
	private readonly capacity: number;
	private readonly refillPerMinute: number;
	private tokens: number;
	private lastRefill: number;

	constructor(capacity: number, refillPerMinute: number, now: number = Date.now()) {
		this.capacity = Math.max(0, capacity);
		this.refillPerMinute = Math.max(0, refillPerMinute);
		this.tokens = this.capacity;
		this.lastRefill = now;
	}

	/** Try to consume one token; returns `false` (no consumption) when empty. */
	tryRemoveToken(now: number = Date.now()): boolean {
		this.refill(now);
		if (this.tokens >= 1) {
			this.tokens -= 1;
			return true;
		}
		return false;
	}

	private refill(now: number): void {
		if (this.refillPerMinute <= 0 || now <= this.lastRefill) {
			return;
		}
		const added = ((now - this.lastRefill) / 60_000) * this.refillPerMinute;
		this.tokens = Math.min(this.capacity, this.tokens + added);
		this.lastRefill = now;
	}
}

/** Batch tokenize request body (`{ inputs: [{ type: 'string', value }, …] }`). */
export function buildTokenizeBody(texts: readonly string[]): JsonValue {
	return { inputs: texts.map((value) => ({ type: 'string', value })) };
}

export interface TokenizeResult {
	/** Token count from a `status: success` output, when present and finite. */
	readonly tokenCount?: number;
	/** Error message from a `status: error` output, when present. */
	readonly error?: string;
}

function parseTokenizeOutput(item: JsonValue): TokenizeResult {
	if (!isRecord(item)) {
		return {};
	}
	if (item.status === 'success') {
		const count = readNumber(item, 'token_count');
		if (count !== undefined && count >= 0) {
			return { tokenCount: count };
		}
		return {};
	}
	const error = readString(item, 'error');
	return error !== undefined ? { error } : {};
}

/**
 * Parse the `outputs[]` array of a tokenize response into exactly `expected`
 * results (positionally aligned to the request `inputs`). Missing or malformed
 * entries become empty results so callers fall back to the heuristic.
 */
export function parseTokenizeResponses(body: JsonValue, expected: number): TokenizeResult[] {
	const outputs = isRecord(body) && Array.isArray(body.outputs) ? body.outputs : [];
	const results: TokenizeResult[] = [];
	for (let i = 0; i < expected; i++) {
		results.push(i < outputs.length ? parseTokenizeOutput(outputs[i] as JsonValue) : {});
	}
	return results;
}

/**
 * Whether a tokenize error means the endpoint is permanently unavailable for
 * this deployment (missing route / feature) rather than a transient failure
 * (rate limit, overloaded upstream). Used to stop retrying for the session.
 */
export function isTokenizeUnavailableError(detail: string): boolean {
	const lower = detail.toLowerCase();
	return (
		lower.includes('route is not found') ||
		lower.includes('http 404') ||
		(lower.includes('tokenize') && lower.includes('not support'))
	);
}
