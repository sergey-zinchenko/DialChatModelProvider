import * as assert from 'assert';
import { normalizeDeployment } from '../deploymentMetadata';
import { type JsonValue } from '../runtimeGuards';

suite('deploymentMetadata — context window', () => {
	test('maxInputTokens = maxTotal − maxCompletion (Session Info adds input + reserved output)', () => {
		const deployment = normalizeDeployment({
			id: 'qwen',
			limits: {
				maxTotalTokens: 262_144,
				maxCompletionTokens: 65_536,
			},
		} as unknown as JsonValue);
		assert.strictEqual(deployment.maxInputTokens, 262_144 - 65_536);
		assert.strictEqual(deployment.maxOutputTokens, 65_536);
	});

	test('explicit maxPromptTokens wins over derived total − completion', () => {
		const deployment = normalizeDeployment({
			id: 'qwen',
			limits: {
				maxTotalTokens: 262_144,
				maxPromptTokens: 200_000,
				maxCompletionTokens: 65_536,
			},
		} as unknown as JsonValue);
		assert.strictEqual(deployment.maxInputTokens, 200_000);
		assert.strictEqual(deployment.maxOutputTokens, 65_536);
	});

	test('reads snake_case limits from listing', () => {
		const deployment = normalizeDeployment({
			id: 'qwen',
			limits: {
				max_total_tokens: 262_144,
				max_completion_tokens: 65_536,
			},
		} as unknown as JsonValue);
		assert.strictEqual(deployment.maxInputTokens, 262_144 - 65_536);
		assert.strictEqual(deployment.maxOutputTokens, 65_536);
	});

	test('falls back to maxTotalTokens when completion limit absent', () => {
		const deployment = normalizeDeployment({
			id: 'qwen',
			limits: { maxTotalTokens: 262_144 },
		} as unknown as JsonValue);
		assert.strictEqual(deployment.maxInputTokens, 262_144);
	});

	test('falls back to maxPromptTokens when total is absent', () => {
		const deployment = normalizeDeployment({
			id: 'qwen',
			limits: { maxPromptTokens: 100_000 },
		} as unknown as JsonValue);
		assert.strictEqual(deployment.maxInputTokens, 100_000);
	});
});
