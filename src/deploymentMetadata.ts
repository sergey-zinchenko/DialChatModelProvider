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
	type DialDeploymentKind,
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

function readLimitNumber(raw: JsonObject, snakeKey: string, camelKey: string): Nullable<number> {
	return readNumber(raw, snakeKey) ?? readNumber(raw, camelKey);
}

function normalizeLimits(raw: Nullable<JsonValue>): Nullable<DialDeploymentLimits> {
	if (!isRecord(raw)) {
		return undefined;
	}
	// Listing serializes snake_case (`max_total_tokens`); config / some payloads use camelCase.
	const maxPromptTokens = readLimitNumber(raw, 'max_prompt_tokens', 'maxPromptTokens');
	const maxCompletionTokens = readLimitNumber(
		raw,
		'max_completion_tokens',
		'maxCompletionTokens',
	);
	const maxTotalTokens = readLimitNumber(raw, 'max_total_tokens', 'maxTotalTokens');
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

function normalizeTopics(raw: JsonObject): readonly string[] | undefined {
	const fromKeywords = [
		...readStringArray(raw, 'description_keywords'),
		...readStringArray(raw, 'descriptionKeywords'),
	];
	const fromTopics = [...readStringArray(raw, 'topics'), ...readStringArray(raw, 'Topics')];
	const merged = [...fromKeywords, ...fromTopics]
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	if (merged.length === 0) {
		return undefined;
	}
	return [...new Set(merged)];
}

function readCapabilityFlag(raw: JsonObject, snakeKey: string, camelKey: string): boolean {
	const caps = readObject(raw, 'capabilities');
	if (!caps) {
		return false;
	}
	return readBoolean(caps, snakeKey) === true || readBoolean(caps, camelKey) === true;
}

/** Infer chat vs embedding from `/openai/models` listing fields. */
export function inferDeploymentKind(rawInput: JsonValue): Nullable<DialDeploymentKind> {
	const raw = isRecord(rawInput) ? rawInput : undefined;
	if (!raw) {
		return undefined;
	}
	if (readCapabilityFlag(raw, 'chat_completion', 'chatCompletion')) {
		return 'chat';
	}
	// Some DIAL models advertise classic "completion" rather than chat_completion.
	if (readCapabilityFlag(raw, 'completion', 'completion')) {
		return 'chat';
	}
	if (readCapabilityFlag(raw, 'embeddings', 'embeddings')) {
		return 'embedding';
	}
	const type = readNonEmptyString(raw, 'type')?.toLowerCase();
	if (type === 'chat' || type === 'completion') {
		return 'chat';
	}
	if (type === 'embedding') {
		return 'embedding';
	}
	return undefined;
}

/**
 * Input budget for {@link vscode.LanguageModelChatInformation.maxInputTokens}.
 *
 * Copilot Session Info shows the context bar as
 * `maxInputTokens + maxOutputTokens` and paints `maxOutputTokens` as
 * "Reserved for response". So `maxInputTokens` must be the **prompt** budget
 * (typically `maxTotalTokens − maxCompletionTokens`), not the full DIAL window.
 */
function deriveMaxInputTokens(
	limits: Nullable<DialDeploymentLimits>,
	maxOutput: Nullable<number>,
): Nullable<number> {
	if (limits?.maxPromptTokens !== undefined) {
		return limits.maxPromptTokens;
	}
	const total = limits?.maxTotalTokens;
	if (total === undefined) {
		return undefined;
	}
	if (maxOutput !== undefined && maxOutput > 0 && maxOutput < total) {
		return total - maxOutput;
	}
	return total;
}

/** Raw model object from DIAL `/openai/models` or legacy `/openai/deployments` listing. */
export function normalizeDeployment(
	rawInput: JsonValue,
	kind?: DialDeploymentKind,
): DialDeployment {
	const raw = asRecord(rawInput);
	const features = normalizeFeatures(readObject(raw, 'features'));
	const limits = normalizeLimits(readObject(raw, 'limits'));
	const defaults = normalizeDefaults(readObject(raw, 'defaults'));
	const resolvedKind = kind ?? inferDeploymentKind(raw);

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
	const maxInput = deriveMaxInputTokens(limits, maxOutput);

	const description = readNonEmptyString(raw, 'description');
	const model = readNonEmptyString(raw, 'model');
	const inputAttachmentTypes = normalizeInputAttachmentTypes(raw);
	const maxInputAttachments = readNumber(raw, 'max_input_attachments');
	const topics = normalizeTopics(raw);

	return {
		id,
		name,
		...(resolvedKind !== undefined ? { kind: resolvedKind } : {}),
		...(description !== undefined ? { description } : {}),
		...(model !== undefined ? { model } : {}),
		...(maxInput !== undefined ? { maxInputTokens: maxInput } : {}),
		...(maxOutput !== undefined ? { maxOutputTokens: maxOutput } : {}),
		...(inputAttachmentTypes !== undefined ? { inputAttachmentTypes } : {}),
		...(maxInputAttachments !== undefined ? { maxInputAttachments } : {}),
		...(topics !== undefined ? { topics } : {}),
		...(features !== undefined ? { features } : {}),
		...(defaults !== undefined ? { defaults } : {}),
		...(limits !== undefined ? { limits } : {}),
	};
}

// Re-export to keep callers single-source.
export { readBoolean };
