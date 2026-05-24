/**
 * Convert between VS Code Language Model API messages and OpenAI-compatible DIAL payloads.
 *
 * VS Code only exposes User and Assistant roles. Messages are forwarded to DIAL as-is
 * (no splitting into system/user based on Copilot XML tags).
 */

import * as vscode from 'vscode';
import {
	type DialChatMessage,
	type DialToolChoice,
	type Nullable,
	type OpenAIToolCall,
	type OpenAIToolDefinition,
} from './types';

/** Map VS Code tools to OpenAI `tools` array. */
export function toOpenAITools(
	tools: Nullable<readonly vscode.LanguageModelChatTool[]>,
): Nullable<readonly OpenAIToolDefinition[]> {
	if (!tools || tools.length === 0) {
		return undefined;
	}
	return tools.map((tool) => ({
		type: 'function' as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema ?? { type: 'object', properties: {} },
		},
	}));
}

/** Map VS Code tool mode to OpenAI `tool_choice`. */
export function toToolChoice(
	toolMode: Nullable<vscode.LanguageModelChatToolMode>,
	hasTools: boolean,
): Nullable<DialToolChoice> {
	if (!hasTools) {
		return undefined;
	}
	if (toolMode === vscode.LanguageModelChatToolMode.Required) {
		return 'required';
	}
	return 'auto';
}

interface MessageLogSummary {
	readonly role: DialChatMessage['role'];
	readonly contentChars: number;
	readonly tool_call_id?: string;
	readonly tool_calls?: number;
}

/** Role/length summary for logs (never log full Copilot prompts). */
export function summarizeMessagesForLog(
	messages: readonly DialChatMessage[],
): readonly MessageLogSummary[] {
	return messages.map((m) => {
		if (m.role === 'tool') {
			return {
				role: m.role,
				tool_call_id: m.tool_call_id,
				contentChars: m.content.length,
			};
		}
		if (m.role === 'assistant') {
			return {
				role: m.role,
				contentChars: m.content?.length ?? 0,
				tool_calls: m.tool_calls?.length ?? 0,
			};
		}
		return {
			role: m.role,
			contentChars: m.content.length,
		};
	});
}

/** VS Code declares request content as `Array<LanguageModelInputPart | unknown>` for forward-compat. */
type RequestMessageContent = vscode.LanguageModelChatRequestMessage['content'];
/** VS Code declares tool-result content as `Array<LanguageModelTextPart | LanguageModelPromptTsxPart | LanguageModelDataPart | unknown>`. */
type ToolResultContent = vscode.LanguageModelToolResultPart['content'];

function readStringValue(value: unknown): Nullable<string> {
	if (typeof value === 'string') {
		return value;
	}
	if (
		typeof value === 'object' &&
		value !== null &&
		'value' in value &&
		typeof (value as { value: unknown }).value === 'string'
	) {
		return (value as { value: string }).value;
	}
	return undefined;
}

function buildAssistantMessage(parts: RequestMessageContent): Nullable<DialChatMessage> {
	const textParts: string[] = [];
	const toolCalls: OpenAIToolCall[] = [];

	for (const part of parts) {
		if (part instanceof vscode.LanguageModelTextPart) {
			textParts.push(part.value);
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			toolCalls.push({
				id: part.callId,
				type: 'function',
				function: {
					name: part.name,
					arguments: JSON.stringify(part.input ?? {}),
				},
			});
		}
	}

	const content = textParts.join('') || null;
	if (toolCalls.length > 0) {
		return { role: 'assistant', content, tool_calls: toolCalls };
	}
	if (content) {
		return { role: 'assistant', content };
	}
	return undefined;
}

function flattenToolResult(content: ToolResultContent): string {
	return content
		.map((part) => {
			if (part instanceof vscode.LanguageModelTextPart) {
				return part.value;
			}
			return readStringValue(part) ?? '';
		})
		.join('');
}

/**
 * Flatten VS Code chat messages into OpenAI-compatible messages, including tool calls/results.
 */
export function toDialMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): DialChatMessage[] {
	const out: DialChatMessage[] = [];

	for (const msg of messages) {
		if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
			const assistant = buildAssistantMessage(msg.content);
			if (assistant) {
				out.push(assistant);
			}
			continue;
		}

		const textParts: string[] = [];
		const toolResults: vscode.LanguageModelToolResultPart[] = [];

		for (const part of msg.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				textParts.push(part.value);
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				toolResults.push(part);
			} else {
				const fallback = readStringValue(part);
				if (fallback) {
					textParts.push(fallback);
				}
			}
		}

		const userText = textParts.join('');
		if (userText) {
			out.push({ role: 'user', content: userText });
		}

		for (const tr of toolResults) {
			out.push({
				role: 'tool',
				tool_call_id: tr.callId,
				content: flattenToolResult(tr.content),
			});
		}
	}

	return out;
}
