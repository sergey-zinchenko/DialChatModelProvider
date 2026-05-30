import * as assert from 'assert';
import {
	buildTokenizeBody,
	heuristicTokenCount,
	isTokenizeUnavailableError,
	parseTokenizeResponses,
	TokenBucket,
} from '../tokenization';
import { normalizeDeployment } from '../deploymentMetadata';
import { type JsonValue } from '../runtimeGuards';

suite('tokenization — heuristicTokenCount', () => {
	test('empty string is zero tokens', () => {
		assert.strictEqual(heuristicTokenCount(''), 0);
	});

	test('rounds up at ~4 chars per token', () => {
		assert.strictEqual(heuristicTokenCount('a'), 1);
		assert.strictEqual(heuristicTokenCount('abcd'), 1);
		assert.strictEqual(heuristicTokenCount('abcde'), 2);
	});
});

suite('tokenization — buildTokenizeBody', () => {
	test('wraps a single text as one string input', () => {
		assert.deepStrictEqual(buildTokenizeBody(['hello']), {
			inputs: [{ type: 'string', value: 'hello' }],
		});
	});

	test('wraps multiple texts as a batch of string inputs', () => {
		assert.deepStrictEqual(buildTokenizeBody(['a', 'b']), {
			inputs: [
				{ type: 'string', value: 'a' },
				{ type: 'string', value: 'b' },
			],
		});
	});
});

suite('tokenization — parseTokenizeResponses', () => {
	test('reads token_count from success outputs positionally', () => {
		const body = {
			outputs: [
				{ status: 'success', token_count: 1 },
				{ status: 'success', token_count: 14 },
			],
		} as unknown as JsonValue;
		assert.deepStrictEqual(parseTokenizeResponses(body, 2), [
			{ tokenCount: 1 },
			{ tokenCount: 14 },
		]);
	});

	test('reads error message from an error output', () => {
		const body = { outputs: [{ status: 'error', error: 'boom' }] } as unknown as JsonValue;
		assert.deepStrictEqual(parseTokenizeResponses(body, 1), [{ error: 'boom' }]);
	});

	test('pads missing/malformed outputs with empty results', () => {
		assert.deepStrictEqual(parseTokenizeResponses(null as unknown as JsonValue, 2), [{}, {}]);
		assert.deepStrictEqual(parseTokenizeResponses({} as unknown as JsonValue, 1), [{}]);
		assert.deepStrictEqual(
			parseTokenizeResponses({ outputs: [{ status: 'success', token_count: 5 }] } as unknown as JsonValue, 2),
			[{ tokenCount: 5 }, {}],
		);
		assert.deepStrictEqual(
			parseTokenizeResponses({ outputs: [{ status: 'success' }] } as unknown as JsonValue, 1),
			[{}],
		);
	});

	test('zero is a valid token count', () => {
		const body = { outputs: [{ status: 'success', token_count: 0 }] } as unknown as JsonValue;
		assert.deepStrictEqual(parseTokenizeResponses(body, 1), [{ tokenCount: 0 }]);
	});
});

suite('tokenization — isTokenizeUnavailableError', () => {
	test('detects missing route / 404', () => {
		assert.ok(isTokenizeUnavailableError('POST /v1/... failed (HTTP 404): Route is not found'));
		assert.ok(isTokenizeUnavailableError('HTTP 404'));
	});

	test('detects unsupported tokenize feature', () => {
		assert.ok(isTokenizeUnavailableError('tokenize is not supported by this deployment'));
	});

	test('treats transient errors as available (retry later)', () => {
		assert.ok(!isTokenizeUnavailableError('socket hang up'));
		assert.ok(!isTokenizeUnavailableError('HTTP 502 bad gateway'));
	});
});

suite('tokenization — TokenBucket', () => {
	test('allows an initial burst up to capacity, then blocks', () => {
		const bucket = new TokenBucket(3, 60, 0);
		assert.strictEqual(bucket.tryRemoveToken(0), true);
		assert.strictEqual(bucket.tryRemoveToken(0), true);
		assert.strictEqual(bucket.tryRemoveToken(0), true);
		assert.strictEqual(bucket.tryRemoveToken(0), false);
	});

	test('refills over time at refillPerMinute', () => {
		const bucket = new TokenBucket(2, 60, 0);
		assert.strictEqual(bucket.tryRemoveToken(0), true);
		assert.strictEqual(bucket.tryRemoveToken(0), true);
		assert.strictEqual(bucket.tryRemoveToken(0), false);
		// 60/min = 1/s; after 1s exactly one token is available again.
		assert.strictEqual(bucket.tryRemoveToken(1_000), true);
		assert.strictEqual(bucket.tryRemoveToken(1_000), false);
	});

	test('never exceeds capacity when idle', () => {
		const bucket = new TokenBucket(2, 600, 0);
		assert.strictEqual(bucket.tryRemoveToken(60_000), true);
		assert.strictEqual(bucket.tryRemoveToken(60_000), true);
		assert.strictEqual(bucket.tryRemoveToken(60_000), false);
	});

	test('zero refill never replenishes', () => {
		const bucket = new TokenBucket(1, 0, 0);
		assert.strictEqual(bucket.tryRemoveToken(0), true);
		assert.strictEqual(bucket.tryRemoveToken(10_000_000), false);
	});
});

function dep(extras: Record<string, unknown> = {}) {
	return normalizeDeployment({ id: 'm', name: 'm', ...extras } as unknown as JsonValue);
}

suite('deploymentMetadata — maxInputTokens derivation', () => {
	test('reserves output budget out of maxTotalTokens', () => {
		const d = dep({ limits: { maxTotalTokens: 65535, maxCompletionTokens: 8000 } });
		assert.strictEqual(d.maxInputTokens, 65535 - 8000);
		assert.strictEqual(d.maxOutputTokens, 8000);
	});

	test('reads snake_case limits from the deployment listing', () => {
		const d = dep({ limits: { max_total_tokens: 65535, max_completion_tokens: 8000 } });
		assert.strictEqual(d.maxInputTokens, 65535 - 8000);
		assert.strictEqual(d.maxOutputTokens, 8000);
	});

	test('prefers explicit maxPromptTokens when present', () => {
		const d = dep({ limits: { maxPromptTokens: 50000, maxTotalTokens: 65535 } });
		assert.strictEqual(d.maxInputTokens, 50000);
	});

	test('falls back to total when no output budget is known', () => {
		const d = dep({ limits: { maxTotalTokens: 65535 } });
		assert.strictEqual(d.maxInputTokens, 65535);
	});

	test('no limits leaves maxInputTokens undefined', () => {
		const d = dep();
		assert.strictEqual(d.maxInputTokens, undefined);
	});
});
