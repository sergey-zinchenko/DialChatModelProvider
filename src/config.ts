import * as vscode from 'vscode';
import { parseOAuthBrowserProfile } from './oauthBrowserProcess';
import { type AuthMethod, type DialConfig, type Nullable } from './types';

function readTrimmed(cfg: vscode.WorkspaceConfiguration, key: string): Nullable<string> {
	const value = cfg.get<string>(key);
	const trimmed = typeof value === 'string' ? value.trim() : '';
	return trimmed.length > 0 ? trimmed : undefined;
}

function readAuthMethod(cfg: vscode.WorkspaceConfiguration): AuthMethod {
	return cfg.get<string>('authMethod') === 'apikey' ? 'apikey' : 'openid';
}

function readPort(cfg: vscode.WorkspaceConfiguration): Nullable<number> {
	const value = cfg.get<number>('oauthCallbackPort');
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		return undefined;
	}
	if (value < 1024 || value > 65_535) {
		return undefined;
	}
	return value;
}

/**
 * Build an immutable {@link DialConfig} snapshot from current VS Code workspace settings.
 *
 * Secrets are NOT read here — they live in {@link vscode.SecretStorage}. See
 * {@link DialSecrets}.
 */
export function readDialConfig(): DialConfig {
	const cfg = vscode.workspace.getConfiguration('dial');
	const oidcClientId = readTrimmed(cfg, 'oidcClientId');
	const oidcScopes = readTrimmed(cfg, 'oidcScopes');
	const oauthCallbackPort = readPort(cfg);

	return {
		serverUrl: readTrimmed(cfg, 'serverUrl') ?? '',
		authMethod: readAuthMethod(cfg),
		oauthBrowserProfile: parseOAuthBrowserProfile(cfg.get<string>('oauthBrowserProfile')),
		...(oidcClientId !== undefined ? { oidcClientId } : {}),
		...(oidcScopes !== undefined ? { oidcScopes } : {}),
		...(oauthCallbackPort !== undefined ? { oauthCallbackPort } : {}),
	};
}

/**
 * Validate that the server URL uses HTTPS (or is a localhost loopback for dev).
 * Returns a warning string to log, or `undefined` if the URL is safe.
 */
export function describeInsecureServerUrl(serverUrl: string): Nullable<string> {
	if (!serverUrl) {
		return undefined;
	}
	let parsed: URL;
	try {
		parsed = new URL(serverUrl);
	} catch {
		return `dial.serverUrl is not a valid URL: ${serverUrl}`;
	}
	if (parsed.protocol === 'https:') {
		return undefined;
	}
	if (parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)) {
		return undefined;
	}
	return `dial.serverUrl uses ${parsed.protocol} — JWT/API-KEY would be sent in plain text. Use HTTPS for any non-loopback server.`;
}

function isLoopbackHostname(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}
