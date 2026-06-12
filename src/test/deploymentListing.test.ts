import * as assert from 'assert';
import { normalizeDeployment } from '../deploymentMetadata';
import { extractDeploymentArray, parseEmbeddingsResponse } from '../embeddingsResponse';
import { type JsonValue } from '../runtimeGuards';

suite('deploymentListing', () => {
	test('normalizeDeployment records kind from listing filter', () => {
		const deployment = normalizeDeployment(
			{ id: 'gpt-4o', display_name: 'GPT-4o' } as unknown as JsonValue,
			'chat',
		);
		assert.strictEqual(deployment.kind, 'chat');
		assert.strictEqual(deployment.id, 'gpt-4o');
	});

	test('normalizeDeployment records embedding kind', () => {
		const deployment = normalizeDeployment(
			{ id: 'text-embed', display_name: 'Embed' } as unknown as JsonValue,
			'embedding',
		);
		assert.strictEqual(deployment.kind, 'embedding');
	});

	test('extractDeploymentArray reads data[] wrapper', () => {
		const list = extractDeploymentArray({
			data: [{ id: 'a' }, { id: 'b' }],
		} as unknown as JsonValue);
		assert.ok(list);
		assert.strictEqual(list.length, 2);
		assert.strictEqual(list[0]!.id, 'a');
	});
});

suite('embeddingsResponse', () => {
	test('parseEmbeddingsResponse maps OpenAI-compatible body', () => {
		const results = parseEmbeddingsResponse(
			{
				object: 'list',
				data: [
					{ object: 'embedding', index: 1, embedding: [0.1, 0.2] },
					{ object: 'embedding', index: 0, embedding: [1, 2, 3] },
				],
			} as unknown as JsonValue,
			2,
		);
		assert.strictEqual(results.length, 2);
		assert.deepStrictEqual(results[0]!.values, [1, 2, 3]);
		assert.deepStrictEqual(results[1]!.values, [0.1, 0.2]);
	});

	test('parseEmbeddingsResponse rejects count mismatch', () => {
		assert.throws(() =>
			parseEmbeddingsResponse(
				{ data: [{ index: 0, embedding: [1] }] } as unknown as JsonValue,
				2,
			),
		);
	});
});
