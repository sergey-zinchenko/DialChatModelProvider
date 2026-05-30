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

/**
 * Read a numeric limit tolerating both casings: DIAL Core config uses camelCase
 * (`maxTotalTokens`), while the `/openai/deployments` listing serializes the same
 * fields in snake_case (`max_total_tokens`), mirroring `input_attachment_types`.
 */
function readLimitNumber(raw: JsonObject, snakeKey: string, camelKey: string): Nullable<number> {
	return readNumber(raw, snakeKey) ?? readNumber(raw, camelKey);
}

function normalizeLimits(raw: Nullable<JsonValue>): Nullable<DialDeploymentLimits> {
	if (!isRecord(raw)) {
		return undefined;
	}
	const maxPromptTokens = readLimitNumber(raw, 'max_prompt_tokens', 'maxPromptTokens');
	const maxCompletionTokens = readLimitNumber(raw, 'max_completion_tokens', 'maxCompletionTokens');
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

/**
 * Safety margin reserved out of a *derived* input budget. The IDE sums
 * per-message `provideTokenCount` results (plain text), but the model counts the
 * fully templated prompt — role markers / special tokens add a few tokens per
 * message that the per-message sum never sees. Reserving a small slice of the
 * window keeps the IDE compacting *before* the prompt + output reservation hits
 * the true ceiling. Proportional to the window, clamped to a sane band.
 */
const INPUT_SAFETY_MARGIN_RATIO = 0.01;
const INPUT_SAFETY_MARGIN_MIN = 64;
const INPUT_SAFETY_MARGIN_MAX = 2048;

function inputSafetyMargin(window: number): number {
	const raw = Math.ceil(window * INPUT_SAFETY_MARGIN_RATIO);
	return Math.min(Math.max(raw, INPUT_SAFETY_MARGIN_MIN), INPUT_SAFETY_MARGIN_MAX);
}

/**
 * Input-token budget for the IDE (`LanguageModelChatInformation.maxInputTokens`).
 * Prefer an explicit prompt limit (authoritative — used as-is); otherwise reserve
 * the output budget *and* a safety margin out of the total context window so the
 * IDE compacts before DIAL rejects an over-budget prompt.
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
	const reservedOutput = maxOutput !== undefined && maxOutput < total ? maxOutput : 0;
	const budget = total - reservedOutput - inputSafetyMargin(total);
	return Math.max(1, budget);
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
	const maxInput = deriveMaxInputTokens(limits, maxOutput);

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
