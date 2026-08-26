import * as assert from 'assert';
import * as vscode from 'vscode';
import { normalizeDeployment } from '../deploymentMetadata';
import { toDialMessages } from '../messageConversion';
import { type JsonValue } from '../runtimeGuards';

function dep(extras: Record<string, unknown> = {}) {
	return normalizeDeployment({ id: 'm', name: 'm', ...extras } as unknown as JsonValue);
}

function imagePart(mimeType: string, bytes: number[]): vscode.LanguageModelChatRequestMessage {
	const data = Uint8Array.from(bytes);
	return {
		name: 'user',
		role: vscode.LanguageModelChatMessageRole.User,
		content: [{ mimeType, data } as unknown as vscode.LanguageModelTextPart],
	};
}

suite('messageConversion — attachments', () => {
	test('image data part becomes custom_content.attachments with base64 data', () => {
		const deployment = dep({ input_attachment_types: ['image/png'] });
		const messages = [imagePart('image/png', [0x89, 0x50, 0x4e, 0x47])];
		const out = toDialMessages(messages, deployment);
		assert.strictEqual(out.length, 1);
		const user = out[0];
		assert.strictEqual(user?.role, 'user');
		if (user?.role !== 'user') {
			return;
		}
		const attachments = user.custom_content?.attachments;
		assert.ok(attachments);
		assert.strictEqual(attachments.length, 1);
		assert.strictEqual(attachments[0]?.type, 'image/png');
		assert.strictEqual(
			attachments[0]?.data,
			Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
		);
	});

	test('cache_control data part is ignored (Copilot prompt-cache marker)', () => {
		const deployment = dep({ input_attachment_types: ['image/png'] });
		const messages: vscode.LanguageModelChatRequestMessage[] = [
			{
				name: 'user',
				role: vscode.LanguageModelChatMessageRole.User,
				content: [
					new vscode.LanguageModelTextPart('hello'),
					{
						mimeType: 'cache_control',
						data: Uint8Array.from(Buffer.from('ephemeral', 'utf8')),
					} as unknown as vscode.LanguageModelTextPart,
				],
			},
		];
		const out = toDialMessages(messages, deployment);
		assert.strictEqual(out.length, 1);
		const user = out[0];
		if (user?.role !== 'user') {
			assert.fail('expected user message');
			return;
		}
		assert.strictEqual(user.content, 'hello');
		assert.strictEqual(user.custom_content?.attachments, undefined);
	});

	test('image/* allow-list accepts image/jpeg', () => {
		const deployment = dep({ input_attachment_types: ['image/*'] });
		const messages = [imagePart('image/jpeg', [0xff, 0xd8, 0xff])];
		const out = toDialMessages(messages, deployment);
		assert.strictEqual(out.length, 1);
		const user = out[0];
		if (user?.role !== 'user') {
			assert.fail('expected user message');
			return;
		}
		assert.strictEqual(user.custom_content?.attachments[0]?.type, 'image/jpeg');
	});

	test('unsupported image MIME throws', () => {
		const deployment = dep({ input_attachment_types: ['image/png'] });
		const messages = [imagePart('image/jpeg', [0xff, 0xd8, 0xff])];
		assert.throws(
			() => toDialMessages(messages, deployment),
			/does not support attachment type "image\/jpeg"/,
		);
	});

	test('text and image combine into one user message', () => {
		const deployment = dep({ input_attachment_types: ['image/png'] });
		const messages: vscode.LanguageModelChatRequestMessage[] = [
			{
				name: 'user',
				role: vscode.LanguageModelChatMessageRole.User,
				content: [
					new vscode.LanguageModelTextPart('describe this'),
					{
						mimeType: 'image/png',
						data: Uint8Array.from([1, 2, 3]),
					} as unknown as vscode.LanguageModelTextPart,
				],
			},
		];
		const out = toDialMessages(messages, deployment);
		assert.strictEqual(out.length, 1);
		const user = out[0];
		if (user?.role !== 'user') {
			assert.fail('expected user message');
			return;
		}
		assert.strictEqual(user.content, 'describe this');
		assert.strictEqual(user.custom_content?.attachments.length, 1);
	});
});

function userTextMessage(...texts: readonly string[]): vscode.LanguageModelChatRequestMessage {
	return {
		name: 'user',
		role: vscode.LanguageModelChatMessageRole.User,
		content: texts.map((t) => new vscode.LanguageModelTextPart(t)),
	};
}

suite('messageConversion — lone surrogates', () => {
	// Copilot trims context by UTF-16 code units and can split an emoji's
	// surrogate pair; the lone half breaks UTF-8 encoding in Python services
	// downstream (500 "surrogates not allowed"). See messageConversion.ts.

	test('lone surrogate in user text is replaced with U+FFFD, valid pair kept', () => {
		const out = toDialMessages(
			[userTextMessage('lock \uD83D\uDD12 and lone \uDD12 tail')],
			dep(),
		);
		const user = out[0];
		if (user?.role !== 'user') {
			assert.fail('expected user message');
			return;
		}
		assert.ok(user.content.isWellFormed());
		assert.strictEqual(user.content, 'lock \uD83D\uDD12 and lone \uFFFD tail');
	});

	test('surrogate pair split across adjacent text parts is re-joined, not mangled', () => {
		const out = toDialMessages([userTextMessage('half \uD83D', '\uDD12 done')], dep());
		const user = out[0];
		if (user?.role !== 'user') {
			assert.fail('expected user message');
			return;
		}
		assert.strictEqual(user.content, 'half \uD83D\uDD12 done');
		assert.ok(!user.content.includes('\uFFFD'));
	});

	test('lone surrogate in assistant text is replaced', () => {
		const messages: vscode.LanguageModelChatRequestMessage[] = [
			{
				name: 'assistant',
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart('truncated \uDE00')],
			},
		];
		const out = toDialMessages(messages, dep());
		const assistant = out[0];
		if (assistant?.role !== 'assistant') {
			assert.fail('expected assistant message');
			return;
		}
		assert.strictEqual(assistant.content, 'truncated \uFFFD');
	});

	test('lone surrogate in tool result is replaced', () => {
		const messages: vscode.LanguageModelChatRequestMessage[] = [
			{
				name: 'user',
				role: vscode.LanguageModelChatMessageRole.User,
				content: [
					new vscode.LanguageModelToolResultPart('call-1', [
						new vscode.LanguageModelTextPart('result \uDD12 text'),
					]),
				],
			},
		];
		const out = toDialMessages(messages, dep());
		const tool = out[0];
		if (tool?.role !== 'tool') {
			assert.fail('expected tool message');
			return;
		}
		assert.strictEqual(tool.tool_call_id, 'call-1');
		assert.strictEqual(tool.content, 'result \uFFFD text');
	});

	test('lone surrogates inside tool-call input are replaced (nested)', () => {
		const messages: vscode.LanguageModelChatRequestMessage[] = [
			{
				name: 'assistant',
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [
					new vscode.LanguageModelToolCallPart('call-2', 'write_file', {
						path: 'a.txt',
						chunks: ['ok \uD83D\uDD12', 'bad \uDD12'],
					}),
				],
			},
		];
		const out = toDialMessages(messages, dep());
		const assistant = out[0];
		if (assistant?.role !== 'assistant') {
			assert.fail('expected assistant message');
			return;
		}
		const args = assistant.tool_calls?.[0]?.function.arguments;
		assert.ok(args);
		assert.ok(args.isWellFormed());
		const parsed = JSON.parse(args) as { path: string; chunks: string[] };
		assert.strictEqual(parsed.path, 'a.txt');
		assert.strictEqual(parsed.chunks[0], 'ok \uD83D\uDD12');
		assert.strictEqual(parsed.chunks[1], 'bad \uFFFD');
	});
});
