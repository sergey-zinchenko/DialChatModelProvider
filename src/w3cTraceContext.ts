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
