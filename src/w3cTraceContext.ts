import { isRecord } from './runtimeGuards';
import { type Nullable } from './types';

/** Copilot / VS Code OTel context passed through `modelOptions._otelTraceContext`. */
export interface OtelTraceContext {
	readonly traceId: string;
	readonly spanId: string;
	readonly traceFlags?: number;
	readonly traceState?: string;
}

export type W3CTraceRequestHeaders = Readonly<{
	traceparent: string;
	tracestate?: string;
}>;

const TRACEPARENT_VERSION = '00';

function normalizeHexSegment(raw: unknown, expectedHexLength: number): string | undefined {
	if (typeof raw !== 'string') {
		return undefined;
	}
	const hex = raw.trim().replace(/-/g, '').toLowerCase();
	if (!/^[0-9a-f]+$/.test(hex) || hex.length !== expectedHexLength) {
		return undefined;
	}
	return hex;
}

function formatTraceFlags(traceFlags: number | undefined): string {
	const value = traceFlags ?? 1;
	if (!Number.isFinite(value) || value < 0 || value > 255) {
		return '01';
	}
	return Math.trunc(value).toString(16).padStart(2, '0');
}

function readTraceState(raw: unknown): string | undefined {
	if (typeof raw !== 'string') {
		return undefined;
	}
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function parseOtelTraceContext(value: unknown): Nullable<OtelTraceContext> {
	if (!isRecord(value)) {
		return undefined;
	}
	const traceId = normalizeHexSegment(value.traceId, 32);
	const spanId = normalizeHexSegment(value.spanId, 16);
	if (traceId === undefined || spanId === undefined) {
		return undefined;
	}
	const traceFlags =
		typeof value.traceFlags === 'number' && Number.isFinite(value.traceFlags)
			? value.traceFlags
			: undefined;
	const traceState = readTraceState(value.traceState);
	return {
		traceId,
		spanId,
		...(traceFlags !== undefined ? { traceFlags } : {}),
		...(traceState !== undefined ? { traceState } : {}),
	};
}

/** Read W3C trace context from Copilot `modelOptions._otelTraceContext` (null/invalid → omit). */
export function readOtelTraceContextFromModelOptions(
	modelOptions: Nullable<{ readonly [key: string]: unknown }>,
): Nullable<OtelTraceContext> {
	if (!isRecord(modelOptions)) {
		return undefined;
	}
	return parseOtelTraceContext(modelOptions._otelTraceContext);
}

/** Build DIAL-compatible W3C Trace Context HTTP headers for chat requests. */
export function buildW3CTraceRequestHeaders(
	ctx: Nullable<OtelTraceContext>,
): Nullable<W3CTraceRequestHeaders> {
	if (ctx === undefined) {
		return undefined;
	}
	const traceId = normalizeHexSegment(ctx.traceId, 32);
	const spanId = normalizeHexSegment(ctx.spanId, 16);
	if (traceId === undefined || spanId === undefined) {
		return undefined;
	}
	const flags = formatTraceFlags(ctx.traceFlags);
	const traceparent = `${TRACEPARENT_VERSION}-${traceId}-${spanId}-${flags}`;
	const tracestate = readTraceState(ctx.traceState);
	return tracestate !== undefined ? { traceparent, tracestate } : { traceparent };
}

/** Flat header map for axios (lowercase keys). */
export function w3cTraceHeadersToHttp(
	headers: Nullable<W3CTraceRequestHeaders>,
): Nullable<Readonly<Record<string, string>>> {
	if (headers === undefined) {
		return undefined;
	}
	return headers.tracestate !== undefined
		? { traceparent: headers.traceparent, tracestate: headers.tracestate }
		: { traceparent: headers.traceparent };
}

/** Parse 32-char trace id from a W3C `traceparent` header value. */
export function parseTraceIdFromTraceparent(traceparent: string): string | undefined {
	const trimmed = traceparent.trim();
	const match = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(trimmed);
	if (!match?.[1]) {
		return undefined;
	}
	return match[1].toLowerCase();
}

/** Read `traceparent` from an HTTP response header map (case-insensitive). */
export function readTraceparentFromHttpHeaders(
	headers: Nullable<Readonly<Record<string, unknown>>>,
): string | undefined {
	if (headers === undefined) {
		return undefined;
	}
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== 'traceparent') {
			continue;
		}
		if (typeof value === 'string' && value.trim().length > 0) {
			return value.trim();
		}
		if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim().length > 0) {
			return value[0].trim();
		}
	}
	return undefined;
}

/** DIAL Core may echo `traceparent` on JSON error bodies. */
export function extractTraceparentFromJson(body: unknown): string | undefined {
	if (!isRecord(body)) {
		return undefined;
	}
	const direct = body.traceparent;
	if (typeof direct === 'string' && direct.trim().length > 0) {
		return direct.trim();
	}
	return undefined;
}

export interface TraceCorrelationLogFields {
	readonly w3cTraceContext: boolean;
	readonly traceId?: string;
	readonly dialTraceId?: string;
}

/** Fields for DIAL Output — trace ids only, never full prompts. */
export function buildTraceCorrelationLog(
	sentTraceHeaders: Nullable<Readonly<Record<string, string>>>,
	dialTraceparent?: Nullable<string>,
): TraceCorrelationLogFields {
	const sentParent = sentTraceHeaders?.traceparent;
	const sentTraceId =
		sentParent !== undefined ? parseTraceIdFromTraceparent(sentParent) : undefined;
	const dialParent = dialTraceparent ?? undefined;
	const dialTraceId =
		dialParent !== undefined ? parseTraceIdFromTraceparent(dialParent) : undefined;

	const fields: TraceCorrelationLogFields = {
		w3cTraceContext: sentTraceId !== undefined,
	};
	if (sentTraceId !== undefined) {
		return {
			...fields,
			traceId: sentTraceId,
			...(dialTraceId !== undefined ? { dialTraceId } : {}),
		};
	}
	if (dialTraceId !== undefined) {
		return { ...fields, dialTraceId };
	}
	return fields;
}
