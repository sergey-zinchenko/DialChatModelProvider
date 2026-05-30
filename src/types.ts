/** Type definitions for DIAL Chat Model Provider. */

import { type JsonObject } from './runtimeGuards';

/**
 * Idiomatic alias for "value may be absent".
 * We use `undefined` exclusively and avoid `null` (per Microsoft TS style guide).
 * The only `null` that survives is in the OpenAI wire format (assistant.content)
 * because JSON cannot represent `undefined`.
 */
export type Nullable<T> = T | undefined;

export type AuthMethod = 'openid' | 'apikey';

export type OAuthBrowserProfileMode = 'auto' | 'system' | 'persistent';

/**
 * Effective extension configuration; treated as immutable for the lifetime of an operation.
 *
 * Secrets (apiKey, oidcClientSecret, oidcInitialAccessToken, access/refresh tokens)
 * live in {@link vscode.SecretStorage} (OS keychain) via {@link DialSecrets}, never
 * in settings.json. This struct only carries non-sensitive identifiers and options.
 */
export interface DialConfig {
	readonly serverUrl: string;
	readonly authMethod: AuthMethod;
	/** Pre-registered OIDC client ID (skips dynamic client registration). Public identifier — safe in settings. */
	readonly oidcClientId?: string;
	/** Space-separated OIDC scopes for the authorization request. */
	readonly oidcScopes?: string;
	/** Loopback port for OAuth redirect (http://127.0.0.1:PORT/oauth-callback). */
	readonly oauthCallbackPort?: number;
	/** Which Chromium profile to use for the OAuth sign-in window. */
	readonly oauthBrowserProfile?: OAuthBrowserProfileMode;
	/** Max `/tokenize` requests per minute (0 disables server tokenization). */
	readonly tokenizeRequestsPerMinute: number;
}

/** A resolved credential — either an API key or an OAuth token. */
export interface Credential {
	readonly token: string;
	readonly method: AuthMethod;
}

export interface OpenIDConfig {
	readonly issuer: string;
	readonly authorization_endpoint: string;
	readonly token_endpoint: string;
	/** OIDC dynamic client registration endpoint (Keycloak / IdP). */
	readonly registration_endpoint?: string;
	readonly scopes_supported?: readonly string[];
}

/** In-memory OIDC client id from dynamic registration (also persisted in settings). */
export interface ClientMetadata {
	readonly client_id: string;
}

export interface DialDeploymentLimits {
	readonly maxPromptTokens?: number;
	readonly maxCompletionTokens?: number;
	readonly maxTotalTokens?: number;
}

/**
 * Deployment features from DIAL listing (`Features` DTO, snake_case JSON).
 * @see ai-dial-core Features
 */
export interface DialDeploymentFeatures {
	readonly rate_endpoint?: string;
	readonly tokenize_endpoint?: string;
	readonly truncate_prompt_endpoint?: string;
	readonly configuration_endpoint?: string;

	readonly system_prompt_supported?: boolean;
	readonly tools_supported?: boolean;
	readonly seed_supported?: boolean;
	readonly url_attachments_supported?: boolean;
	readonly folder_attachments_supported?: boolean;
	readonly allow_resume?: boolean;
	readonly accessible_by_per_request_key?: boolean;
	readonly content_parts_supported?: boolean;
	readonly temperature_supported?: boolean;
	readonly cache_supported?: boolean;
	readonly auto_caching_supported?: boolean;
	readonly consent_required?: boolean;
	readonly parallel_tool_calls_supported?: boolean;
	readonly assistant_attachments_in_request_supported?: boolean;
	readonly support_comment_in_rate_response?: boolean;

	/** Upstream accepts `max_tokens` in chat completions. */
	readonly max_tokens_supported?: boolean;
	/** Upstream accepts `max_completion_tokens` in chat completions. */
	readonly max_completion_tokens_supported?: boolean;
	/** Client may send a non-default `temperature`. */
	readonly custom_temperature_supported?: boolean;
}

export interface DialDeployment {
	readonly id: string;
	readonly name?: string;
	readonly description?: string;
	readonly model?: string;
	readonly maxInputTokens?: number;
	readonly maxOutputTokens?: number;
	/** Allowed MIME types for input attachments (`input_attachment_types` from listing). */
	readonly inputAttachmentTypes?: readonly string[];
	/** Maximum attachments per user message (`max_input_attachments` from listing). */
	readonly maxInputAttachments?: number;
	/** DIAL deployment feature flags from the listing API. */
	readonly features?: DialDeploymentFeatures;
	/** Default chat completion parameters declared by DIAL for this deployment. */
	readonly defaults?: JsonObject;
	readonly limits?: DialDeploymentLimits;
}

/** DIAL `custom_content.attachments` entry with inline base64 payload. */
export interface DialInputAttachment {
	readonly type: string;
	readonly data: string;
}

export interface DialMessageCustomContent {
	readonly attachments: readonly DialInputAttachment[];
}

export interface OpenAIToolDefinition {
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly description: string;
		readonly parameters: object;
	};
}

export interface OpenAIToolCall {
	readonly id: string;
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly arguments: string;
	};
}

export type DialChatMessage =
	| { readonly role: 'system'; readonly content: string }
	| {
			readonly role: 'user';
			readonly content: string;
			readonly custom_content?: DialMessageCustomContent;
	  }
	| {
			readonly role: 'assistant';
			/**
			 * OpenAI wire format: literally `null` when the assistant emits `tool_calls`.
			 * This is the one place where `null` is required — JSON cannot encode `undefined`.
			 */
			readonly content: string | null;
			readonly tool_calls?: readonly OpenAIToolCall[];
	  }
	| { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };

export type DialToolChoice =
	| 'auto'
	| 'required'
	| 'none'
	| { readonly type: 'function'; readonly function: { readonly name: string } };

export interface DialChatRequest {
	readonly messages: readonly DialChatMessage[];
	readonly temperature?: number;
	/** OpenAI chat completions output cap (most non-o-series models). */
	readonly max_tokens?: number;
	/** OpenAI chat completions output cap (GPT-5 / o-series models). */
	readonly max_completion_tokens?: number;
	readonly tools?: readonly OpenAIToolDefinition[];
	readonly tool_choice?: DialToolChoice;
	readonly stream?: boolean;
}

/**
 * Input entry for the DIAL `/v1/deployments/{id}/tokenize` endpoint.
 * Either a plain string or a (partial) chat request whose messages/tools are tokenized.
 */
export type DialTokenizeInput =
	| { readonly type: 'string'; readonly value: string }
	| {
			readonly type: 'request';
			readonly value: {
				readonly messages: readonly DialChatMessage[];
				readonly tools?: readonly OpenAIToolDefinition[];
			};
	  };
