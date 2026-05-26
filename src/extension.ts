import * as vscode from 'vscode';
import { describeInsecureServerUrl, readDialConfig } from './config';
import { CredentialStore } from './credentialStore';
import { DialModelService } from './dialModelService';
import { DialSecrets } from './dialSecrets';
import { initDialLogger, dialLog } from './logger';
import {
	deploymentAttachmentSummary,
	deploymentSupportsImageInput,
} from './attachmentCapabilities';
import { type DialDeployment } from './types';

/**
 * activate() is synchronous — every constructor only sets up subscriptions.
 * Async work (token restore, model fetching) happens reactively in the
 * background so nothing blocks Copilot's model resolution pipeline.
 */
export function activate(context: vscode.ExtensionContext): void {
	initDialLogger(context);
	dialLog.info('activate() start');

	const config = readDialConfig();

	const insecureWarning = describeInsecureServerUrl(config.serverUrl);
	if (insecureWarning) {
		dialLog.warn(insecureWarning);
		void vscode.window.showWarningMessage(`DIAL: ${insecureWarning}`);
	}

	const credentials = new CredentialStore(context, config);
	const modelService = new DialModelService(credentials, config);
	const secrets = new DialSecrets(context);

	const modelsChanged = new vscode.EventEmitter<void>();
	const bridgeSub = modelService.onDidChangeModels(() => modelsChanged.fire());

	// Vendor string MUST match the languageModelChatProviders contribution in package.json.
	const providerReg = vscode.lm.registerLanguageModelChatProvider('dial', {
		onDidChangeLanguageModelChatInformation: modelsChanged.event,

		provideLanguageModelChatInformation(
			options: vscode.PrepareLanguageModelChatModelOptions,
			token: vscode.CancellationToken,
		): vscode.LanguageModelChatInformation[] {
			if (token.isCancellationRequested) {
				dialLog.info('provideLanguageModelChatInformation cancelled');
				return [];
			}

			const count = modelService.models.length;
			if (options.silent && count === 0) {
				dialLog.info(
					'provideLanguageModelChatInformation silent=true, models=0 — returning empty (no auth prompt)',
				);
				return [];
			}

			const models = toModelInfo(modelService.models);
			dialLog.info(
				'provideLanguageModelChatInformation',
				`silent=${Boolean(options.silent)}`,
				`returning=${models.length}`,
				models.length > 0 ? models.map((m) => m.id).join(', ') : '(empty)',
			);
			return models;
		},

		provideTokenCount(
			_model: vscode.LanguageModelChatInformation,
			text: string | vscode.LanguageModelChatRequestMessage,
			_token: vscode.CancellationToken,
		): Thenable<number> {
			return Promise.resolve(estimateTokens(text));
		},

		provideLanguageModelChatResponse(
			model: vscode.LanguageModelChatInformation,
			messages: readonly vscode.LanguageModelChatRequestMessage[],
			options: vscode.ProvideLanguageModelChatResponseOptions,
			progress: vscode.Progress<vscode.LanguageModelResponsePart>,
			token: vscode.CancellationToken,
		): Thenable<void> {
			return (async () => {
				if (token.isCancellationRequested) {
					dialLog.warn(`Chat cancelled before start model=${model.id}`);
					return;
				}
				dialLog.info(
					`provideLanguageModelChatResponse model=${model.id} name=${model.name}`,
				);
				try {
					await modelService.streamChat(model.id, messages, options, progress, token);
				} catch (e: unknown) {
					const detail = e instanceof Error ? e.message : String(e);
					dialLog.error(
						`provideLanguageModelChatResponse failed model=${model.id}`,
						detail,
					);
					throw new Error(`DIAL chat error (${model.name}): ${detail}`);
				}
			})();
		},
	});

	context.subscriptions.push(
		vscode.commands.registerCommand('dial.login', async () => {
			try {
				await credentials.login();
				const n = await modelService.awaitModelUpdate();
				if (n === 0) {
					dialLog.warn(
						'Login succeeded but no deployments returned — check DIAL Output for GET /openai/deployments details',
					);
					vscode.window.showWarningMessage(
						'DIAL: logged in, but no models found. Open Output → DIAL for details.',
					);
				} else {
					vscode.window.showInformationMessage(
						`DIAL: logged in, ${n} model(s) available.`,
					);
				}
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				dialLog.error('dial.login command failed', msg);
				vscode.window.showErrorMessage(`DIAL login failed: ${msg}`);
			}
		}),

		vscode.commands.registerCommand('dial.logout', async () => {
			try {
				await credentials.logout();
				vscode.window.showInformationMessage('DIAL: logged out.');
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				vscode.window.showErrorMessage(`DIAL logout failed: ${msg}`);
			}
		}),

		vscode.commands.registerCommand('dial.clearOidcClient', async () => {
			try {
				const cleared = await credentials.clearOidcClient();
				const next = await credentials.describeOidcClientSource();
				if (cleared) {
					vscode.window.showInformationMessage(
						`DIAL: cleared OAuth client ${cleared}. Next login will register a new client.`,
					);
					dialLog.info('dial.clearOidcClient', `cleared=${cleared}`, `next=${next}`);
				} else {
					vscode.window.showInformationMessage(
						`DIAL: no stored OAuth client. Current: ${next}`,
					);
				}
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				vscode.window.showErrorMessage(`DIAL clear OAuth client failed: ${msg}`);
			}
		}),

		vscode.commands.registerCommand('dial.openSettings', () =>
			vscode.commands.executeCommand('workbench.action.openSettings', 'dial'),
		),

		vscode.commands.registerCommand('dial.setApiKey', async () => {
			const value = await vscode.window.showInputBox({
				prompt: 'Enter your DIAL API Key (stored in the OS keychain)',
				placeHolder: 'API Key',
				password: true,
				ignoreFocusOut: true,
			});
			if (!value) {
				return;
			}
			await secrets.setApiKey(value.trim());
			dialLog.info('API key stored in secure storage (OS keychain)');
			vscode.window.showInformationMessage(
				'DIAL: API key saved securely. Run DIAL: Login to use it.',
			);
		}),

		vscode.commands.registerCommand('dial.setOidcClientSecret', async () => {
			const value = await vscode.window.showInputBox({
				prompt: 'Enter the OIDC client secret (only for confidential clients)',
				placeHolder: 'leave empty to clear',
				password: true,
				ignoreFocusOut: true,
			});
			await secrets.setOidcClientSecret(value?.trim() || undefined);
			dialLog.info(
				value ? 'OIDC client secret stored in OS keychain' : 'OIDC client secret cleared',
			);
		}),

		vscode.commands.registerCommand('dial.setOidcInitialAccessToken', async () => {
			const value = await vscode.window.showInputBox({
				prompt: 'Enter the Keycloak initial access token (one-time, for authenticated DCR)',
				placeHolder: 'leave empty to clear',
				password: true,
				ignoreFocusOut: true,
			});
			await secrets.setOidcInitialAccessToken(value?.trim() || undefined);
			dialLog.info(
				value
					? 'OIDC initial access token stored in OS keychain'
					: 'OIDC initial access token cleared',
			);
		}),

		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('dial')) {
				vscode.window
					.showInformationMessage(
						'DIAL configuration changed. Reload window for changes to take effect.',
						'Reload',
					)
					.then((sel) => {
						if (sel === 'Reload') {
							void vscode.commands.executeCommand('workbench.action.reloadWindow');
						}
					});
			}
		}),

		credentials,
		modelService,
		modelsChanged,
		bridgeSub,
		providerReg,
	);

	credentials.trySilentRestore().catch((e: unknown) => {
		const detail = e instanceof Error ? e.message : String(e);
		dialLog.warn(`Silent restore failed: ${detail}`);
	});

	dialLog.info('activate() done (sync)');
}

export function deactivate(): void {
	// Cleanup handled by subscription disposables.
}

function toModelInfo(
	deployments: readonly DialDeployment[],
): vscode.LanguageModelChatInformation[] {
	return deployments.map((d) => {
		const attachmentNote = deploymentAttachmentSummary(d);
		const baseTooltip = d.description || `DIAL deployment: ${d.name || d.id}`;
		return {
			id: d.id,
			name: d.name || d.id,
			family: d.model || 'dial-chat',
			detail: 'DIAL',
			tooltip: attachmentNote ? `${baseTooltip} — ${attachmentNote}` : baseTooltip,
			version: '1.0.0',
			maxInputTokens: d.maxInputTokens || 120_000,
			maxOutputTokens: d.maxOutputTokens || 8192,
			capabilities: {
				// Copilot Agent chat picker requires toolCalling; default true unless DIAL explicitly disables tools.
				toolCalling: d.features?.tools_supported !== false,
				imageInput: deploymentSupportsImageInput(d),
			},
		};
	});
}

function estimateTokens(text: string | vscode.LanguageModelChatRequestMessage): number {
	const s = typeof text === 'string' ? text : flattenContent(text.content);
	return Math.ceil(s.length / 4);
}

type RequestMessageContent = vscode.LanguageModelChatRequestMessage['content'];

function flattenContent(content: RequestMessageContent): string {
	return content
		.map((part) => {
			if (part && typeof part === 'object' && 'value' in part) {
				const value = (part as { value?: unknown }).value;
				return typeof value === 'string' ? value : '';
			}
			return '';
		})
		.join('');
}
