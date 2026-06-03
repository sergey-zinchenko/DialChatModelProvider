import * as assert from 'assert';
import { normalizeDeployment } from '../deploymentMetadata';
import {
	buildModelConfigurationSchema,
	DEFAULT_REASONING_EFFORT_LEVELS,
	resolveReasoningEffortLevels,
} from '../modelConfigurationSchema';
import { type JsonValue } from '../runtimeGuards';

suite('modelConfigurationSchema', () => {
	test('returns undefined when reasoning_efforts_supported is absent', () => {
		const deployment = normalizeDeployment({
			id: 'gpt-4o',
			features: { tools_supported: true },
		} as unknown as JsonValue);
		assert.strictEqual(buildModelConfigurationSchema(deployment), undefined);
	});

	test('builds reasoningEffort schema when flag is true', () => {
		const deployment = normalizeDeployment({
			id: 'qwen3.6-27b-awq',
			features: { reasoning_efforts_supported: true },
			defaults: { reasoning_effort: 'none' },
		} as unknown as JsonValue);
		const schema = buildModelConfigurationSchema(deployment);
		assert.ok(schema?.properties?.reasoningEffort);
		const prop = schema!.properties!.reasoningEffort;
		assert.deepStrictEqual(prop.enum, [...DEFAULT_REASONING_EFFORT_LEVELS]);
		assert.strictEqual(prop.default, 'none');
		assert.strictEqual(prop.group, 'navigation');
	});

	test('resolveReasoningEffortLevels honors deployment-specific list when provided', () => {
		const deployment = normalizeDeployment({
			id: 'custom',
			features: { reasoning_efforts_supported: true },
			defaults: { reasoning_effort_levels: ['low', 'high'] },
		} as unknown as JsonValue);
		assert.deepStrictEqual(resolveReasoningEffortLevels(deployment), ['low', 'high']);
	});
});
