import { summarizeMessagesForLog } from './messageConversion';
import { isRecord, type JsonObject, type JsonValue } from './runtimeGuards';
import {
	type DialChatMessage,
	type DialChatRequest,
	type DialDeployment,
	type DialDeploymentFeatures,
	type Nullable,
} from './types';

export type OutputTokenLimitField = 'max_completion_tokens' | 'max_tokens';

/** DIAL Core defaults when a feature flag is absent from listing. */
const DIAL_FEATURE_DEFAULTS = {
	max_tokens_supported: true,
	max_completion_tokens_supported: false,
	custom_temperature_supported: true,
} as const satisfies Record<
	keyof Pick<
		DialDeploymentFeatures,
		'max_tokens_supported' | 'max_completion_tokens_supported' | 'custom_temperature_supported'
	>,
	boolean
>;

function readFeatureFlag(
	features: Nullable<DialDeploymentFeatures>,
	key: keyof typeof DIAL_FEATURE_DEFAULTS,
): boolean {
	const value = features?.[key];
	if (typeof value === 'boolean') {
		return value;
	}
	return DIAL_FEATURE_DEFAULTS[key];
}

/**
 * Which output token limit field to send, from DIAL `features`:
 * - `max_completion_tokens_supported` wins when both are true
 * - else `max_tokens_supported`
 * - else omit both limit parameters
 */
export function selectOutputTokenLimitField(
	deployment?: DialDeployment,
): Nullable<OutputTokenLimitField> {
	const features = deployment?.features;

	if (readFeatureFlag(features, 'max_completion_tokens_supported')) {
		return 'max_completion_tokens';
	}
	if (readFeatureFlag(features, 'max_tokens_supported')) {
		return 'max_tokens';
	}
	return undefined;
}

/** Whether to include `temperature` in the request (from `custom_temperature_supported`). */
function supportsCustomTemperature(deployment?: Pick<DialDeployment, 'features'>): boolean {
	return readFeatureFlag(deployment?.features, 'custom_temperature_supported');
}

function readDefaultNumber(defaults: Nullable<JsonObject>, key: string): Nullable<number> {
	const value = defaults?.[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function defaultMaxOutput(deployment?: DialDeployment): number {
	const limits = deployment?.limits;
	if (limits?.maxCompletionTokens) {
		return limits.maxCompletionTokens;
	}
	const defaults = deployment?.defaults;
	const fromCompletion = readDefaultNumber(defaults, 'max_completion_tokens');
	if (fromCompletion !== undefined) {
		return fromCompletion;
	}
	const fromMax = readDefaultNumber(defaults, 'max_tokens');
	if (fromMax !== undefined) {
		return fromMax;
	}
	if (deployment?.maxOutputTokens) {
		return deployment.maxOutputTokens;
	}
	return 8192;
}

/** Apply the correct output token limit field for the deployment. */
function applyOutputTokenLimit(
	request: DialChatRequest,
	deployment: Nullable<DialDeployment>,
	maxOutput?: number,
): DialChatRequest {
	const { max_tokens: _omitMax, max_completion_tokens: _omitCompletion, ...rest } = request;
	const field = selectOutputTokenLimitField(deployment);
	if (field === undefined) {
		return { ...rest };
	}
	const limit = maxOutput ?? defaultMaxOutput(deployment);
	if (field === 'max_completion_tokens') {
		return { ...rest, max_completion_tokens: limit };
	}
	return { ...rest, max_tokens: limit };
}

/** Apply temperature only when the deployment supports it; honor DIAL defaults when set. */
function applyTemperature(
	request: DialChatRequest,
	deployment: Nullable<DialDeployment>,
): DialChatRequest {
	if (!supportsCustomTemperature(deployment)) {
		const { temperature: _omit, ...rest } = request;
		return { ...rest };
	}

	const defaultTemp = readDefaultNumber(deployment?.defaults, 'temperature');
	if (defaultTemp !== undefined) {
		return { ...request, temperature: defaultTemp };
	}
	if (request.temperature === undefined) {
		return { ...request, temperature: 0.7 };
	}
	return request;
}

/**
 * Apply deployment-aware constraints from DIAL metadata
 * (features, defaults, limits) before sending a chat completion request.
 */
export function applyDeploymentConstraints(
	request: DialChatRequest,
	deployment: Nullable<DialDeployment>,
): DialChatRequest {
	return applyTemperature(applyOutputTokenLimit(request, deployment), deployment);
}

/** Serialize for the OpenAI-compatible API (only one of the limit fields). */
export function toApiRequestBody(request: DialChatRequest): JsonObject {
	const { max_tokens, max_completion_tokens, ...rest } = request;
	// DialChatRequest is a tagged union with `readonly` arrays; widen via `unknown` because
	// the union does not carry a JsonObject index signature even though every leaf is JSON.
	const body: Record<string, JsonValue> = { ...(rest as unknown as Record<string, JsonValue>) };
	if (max_completion_tokens !== undefined) {
		body.max_completion_tokens = max_completion_tokens;
	} else if (max_tokens !== undefined) {
		body.max_tokens = max_tokens;
	}
	return body;
}

/**
 * Upstream says `max_tokens` is the wrong field (typical for o-series / GPT-5
 * proxies that expect `max_completion_tokens`).
 *
 * Both regexes are anchored to a `max_tokens` token that is NOT preceded by
 * `completion_` — otherwise an error mentioning the other field would match
 * here and we would swap in the wrong direction.
 */
export function isUnsupportedMaxTokensError(message: string): boolean {
	return (
		/(?<!completion_)max_tokens.*not supported/i.test(message) ||
		/unsupported_parameter.*(?<!completion_)max_tokens/i.test(message)
	);
}

/** Upstream says `max_completion_tokens` is the wrong field (classic chat models). */
export function isUnsupportedMaxCompletionTokensError(message: string): boolean {
	return (
		/max_completion_tokens.*not supported/i.test(message) ||
		/unsupported_parameter.*max_completion_tokens/i.test(message)
	);
}

export function isUnsupportedTemperatureError(message: string): boolean {
	return /temperature.*not support/i.test(message) || /unsupported.*temperature/i.test(message);
}

/** Human-readable summary for logs (no message bodies). */
export function summarizeChatRequest(
	request: DialChatRequest,
	deployment?: DialDeployment,
): Record<string, unknown> {
	return {
		deploymentId: deployment?.id,
		model: deployment?.model,
		messageCount: request.messages.length,
		messages: summarizeMessagesForLog(request.messages),
		toolCount: request.tools?.length ?? 0,
		toolChoice: request.tool_choice,
		stream: request.stream,
		temperature: request.temperature ?? '(omitted)',
		max_tokens: request.max_tokens,
		max_completion_tokens: request.max_completion_tokens,
		features: deployment?.features
			? {
					max_tokens_supported: deployment.features.max_tokens_supported,
					max_completion_tokens_supported:
						deployment.features.max_completion_tokens_supported,
					custom_temperature_supported: deployment.features.custom_temperature_supported,
					tools_supported: deployment.features.tools_supported,
					system_prompt_supported: deployment.features.system_prompt_supported,
				}
			: undefined,
		selectedLimitField: selectOutputTokenLimitField(deployment),
	};
}

/** Redact message bodies from API payload before logging. */
export function sanitizeApiBodyForLog(body: JsonObject): Record<string, unknown> {
	const messages = body.messages;
	if (!Array.isArray(messages)) {
		return { ...body };
	}
	const typed = messages.filter(isDialChatMessageLike);
	return { ...body, messages: summarizeMessagesForLog(typed) };
}

const KNOWN_CHAT_ROLES: ReadonlySet<string> = new Set<DialChatMessage['role']>([
	'system',
	'user',
	'assistant',
	'tool',
]);

function isDialChatMessageLike(value: JsonValue): value is DialChatMessage & JsonObject {
	return isRecord(value) && typeof value.role === 'string' && KNOWN_CHAT_ROLES.has(value.role);
}

export function forceMaxCompletionTokens(request: DialChatRequest): DialChatRequest {
	const limit = request.max_tokens ?? request.max_completion_tokens;
	const { max_tokens: _omit, ...rest } = request;
	if (limit !== undefined) {
		return { ...rest, max_completion_tokens: limit };
	}
	return { ...rest };
}

export function forceMaxTokens(request: DialChatRequest): DialChatRequest {
	const limit = request.max_completion_tokens ?? request.max_tokens;
	const { max_completion_tokens: _omit, ...rest } = request;
	if (limit !== undefined) {
		return { ...rest, max_tokens: limit };
	}
	return { ...rest };
}

/** Drop both output-token limit fields — let upstream apply its internal default. */
export function dropOutputTokenLimit(request: DialChatRequest): DialChatRequest {
	const { max_tokens: _t, max_completion_tokens: _c, ...rest } = request;
	return { ...rest };
}

/** Drop `temperature` — used after upstream rejects it as unsupported. */
export function dropTemperature(request: DialChatRequest): DialChatRequest {
	const { temperature: _t, ...rest } = request;
	return { ...rest };
}
