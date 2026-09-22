import * as assert from 'assert';
import {
	buildW3CTraceRequestHeaders,
	parseOtelTraceContext,
	readOtelTraceContextFromModelOptions,
	w3cTraceHeadersToHttp,
} from '../w3cTraceContext';

suite('w3cTraceContext', () => {
	test('buildW3CTraceRequestHeaders formats traceparent (default sampled flags)', () => {
		const headers = buildW3CTraceRequestHeaders({
			traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
			spanId: '00f067aa0ba902b7',
		});
		assert.ok(headers);
		assert.strictEqual(
			headers.traceparent,
			'00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
		);
		assert.strictEqual(headers.tracestate, undefined);
	});

	test('buildW3CTraceRequestHeaders honors traceFlags and tracestate', () => {
		const headers = buildW3CTraceRequestHeaders({
			traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
			spanId: '00f067aa0ba902b7',
			traceFlags: 0,
			traceState: 'vendor=value',
		});
		assert.ok(headers);
		assert.strictEqual(
			headers.traceparent,
			'00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
		);
		assert.strictEqual(headers.tracestate, 'vendor=value');
	});

	test('parseOtelTraceContext normalizes dashed hex ids', () => {
		const ctx = parseOtelTraceContext({
			traceId: '4bf92f35-77b3-4da6-a3ce-929d0e0e4736',
			spanId: '00f067aa0ba902b7',
		});
		assert.ok(ctx);
		assert.strictEqual(ctx.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
	});

	test('parseOtelTraceContext rejects invalid lengths', () => {
		assert.strictEqual(
			parseOtelTraceContext({ traceId: 'abc', spanId: '00f067aa0ba902b7' }),
			undefined,
		);
	});

	test('readOtelTraceContextFromModelOptions reads _otelTraceContext', () => {
		const ctx = readOtelTraceContextFromModelOptions({
			_otelTraceContext: {
				traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
				spanId: '00f067aa0ba902b7',
			},
			_capturingTokenCorrelationId: 'ignore-me',
		});
		assert.ok(ctx);
		assert.strictEqual(ctx.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
	});

	test('w3cTraceHeadersToHttp omits tracestate when absent', () => {
		const http = w3cTraceHeadersToHttp({
			traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
		});
		assert.deepStrictEqual(http, {
			traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
		});
	});
});
