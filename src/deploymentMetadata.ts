import {
	asRecord,
	isRecord,
	readBoolean,
	readNonEmptyString,
	readNumber,
	readObject,
	readStringArray,
	type JsonObject,
	type JsonValue,
} from './runtimeGuards';
import {
	type DialDeployment,
	type DialDeploymentFeatures,
	type DialDeploymentLimits,
	type Nullable,
} from './types';

const FEATURE_KEYS = [
	'rate_endpoint',
	'tokenize_endpoint',
	'truncate_prompt_endpoint',
	'configuration_endpoint',
	'system_prompt_supported',
	'tools_supported',
	'seed_supported',
	'url_attachments_supported',
	'folder_attachments_supported',
	'allow_resume',
	'accessible_by_per_request_key',
	'content_parts_supported',
	'temperature_supported',
	'cache_supported',
	'auto_caching_supported',
	'consent_required',
	'parallel_tool_calls_supported',
	'assistant_attachments_in_request_supported',
	'support_comment_in_rate_response',
	'max_tokens_supported',
	'max_completion_tokens_supported',
	'custom_temperature_supported',
] as const satisfies readonly (keyof DialDeploymentFeatures)[];

function normalizeFeatures(raw: Nullable<JsonValue>): Nullable<DialDeploymentFeatures> {
	if (!isRecord(raw)) {
		return undefined;
	}

	const out: Record<string, string | boolean> = {};
	for (const key of FEATURE_KEYS) {
		const value = raw[key];
		if (typeof value === 'string' || typeof value === 'boolean') {
			out[key] = value;
		}
	}
	return out as DialDeploymentFeatures;
}

function normalizeLimits(raw: Nullable<JsonValue>): Nullable<DialDeploymentLimits> {
	if (!isRecord(raw)) {
		return undefined;
	}
	const maxPromptTokens = readNumber(raw, 'maxPromptTokens');
	const maxCompletionTokens = readNumber(raw, 'maxCompletionTokens');
	const maxTotalTokens = readNumber(raw, 'maxTotalTokens');
	if (
		maxPromptTokens === undefined &&
		maxCompletionTokens === undefined &&
		maxTotalTokens === undefined
	) {
		return undefined;
	}
	return {
		...(maxPromptTokens !== undefined ? { maxPromptTokens } : {}),
		...(maxCompletionTokens !== undefined ? { maxCompletionTokens } : {}),
		...(maxTotalTokens !== undefined ? { maxTotalTokens } : {}),
	};
}

function normalizeDefaults(raw: Nullable<JsonValue>): Nullable<JsonObject> {
	return isRecord(raw) ? { ...raw } : undefined;
}

function normalizeInputAttachmentTypes(raw: JsonObject): readonly string[] | undefined {
	const types = readStringArray(raw, 'input_attachment_types');
	return types.length > 0 ? types : undefined;
}

/** Raw deployment object from DIAL `/openai/deployments` listing. */
export function normalizeDeployment(rawInput: JsonValue): DialDeployment {
	const raw = asRecord(rawInput);
	const features = normalizeFeatures(readObject(raw, 'features'));
	const limits = normalizeLimits(readObject(raw, 'limits'));
	const defaults = normalizeDefaults(readObject(raw, 'defaults'));

	const id = readNonEmptyString(raw, 'id') ?? readNonEmptyString(raw, 'name') ?? 'unknown';
	const name =
		readNonEmptyString(raw, 'display_name') ??
		readNonEmptyString(raw, 'name') ??
		readNonEmptyString(raw, 'id') ??
		'unknown';

	const maxOutput =
		limits?.maxCompletionTokens ??
		(defaults && typeof defaults.max_completion_tokens === 'number'
			? defaults.max_completion_tokens
			: undefined) ??
		(defaults && typeof defaults.max_tokens === 'number' ? defaults.max_tokens : undefined);
	const maxInput = limits?.maxPromptTokens ?? limits?.maxTotalTokens;

	const description = readNonEmptyString(raw, 'description');
	const model = readNonEmptyString(raw, 'model');
	const inputAttachmentTypes = normalizeInputAttachmentTypes(raw);
	const maxInputAttachments = readNumber(raw, 'max_input_attachments');

	return {
		id,
		name,
		...(description !== undefined ? { description } : {}),
		...(model !== undefined ? { model } : {}),
		...(maxInput !== undefined ? { maxInputTokens: maxInput } : {}),
		...(maxOutput !== undefined ? { maxOutputTokens: maxOutput } : {}),
		...(inputAttachmentTypes !== undefined ? { inputAttachmentTypes } : {}),
		...(maxInputAttachments !== undefined ? { maxInputAttachments } : {}),
		...(features !== undefined ? { features } : {}),
		...(defaults !== undefined ? { defaults } : {}),
		...(limits !== undefined ? { limits } : {}),
	};
}

// Re-export to keep callers single-source.
export { readBoolean };
