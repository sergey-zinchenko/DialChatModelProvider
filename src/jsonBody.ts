/**
 * JSON serialization that is safe for strict UTF-8 JSON parsers (DIAL / OpenAI-family).
 *
 * `JSON.stringify` turns unpaired UTF-16 surrogates into `\uDxxx` escapes. Those escapes
 * have no UTF-8 encoding, so strict servers reject the body with HTTP 400. Copilot can
 * still hand extension providers conversation/tool text that contains lone surrogates
 * (truncation mid-emoji); sanitize before POST.
 *
 * @see microsoft/vscode#332564 (`stringifyJsonBody` in Copilot)
 */

/** Matches a single JSON escape; see Copilot `jsonBody.ts` for the linear-scan rationale. */
const JSON_ESCAPE = /\\(u[dD][89a-fA-F][0-9a-fA-F]{2}|[\s\S])/g;

const UNICODE_REPLACEMENT_ESCAPE = '\\ufffd';

/**
 * Serialize `value` to JSON, replacing unpaired surrogate escapes with `\ufffd`.
 * @throws if `value` has no JSON representation (`undefined`, functions, …).
 */
export function stringifyJsonBody(value: unknown): string {
	const serialized = JSON.stringify(value);
	if (typeof serialized !== 'string') {
		throw new Error(
			`Illegal arguments! A value of type '${typeof value}' has no JSON representation!`,
		);
	}
	// `JSON.stringify` only emits `\ud…` for unpaired surrogates (lowercase). Skip the scan
	// when the body cannot contain such an escape.
	if (!serialized.includes('\\ud')) {
		return serialized;
	}
	return serialized.replace(JSON_ESCAPE, (match, escape: string) =>
		escape.length === 1 ? match : UNICODE_REPLACEMENT_ESCAPE,
	);
}
