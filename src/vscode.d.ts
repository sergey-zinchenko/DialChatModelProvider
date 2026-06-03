import 'vscode';
import type { DialLanguageModelConfigurationSchema } from './modelConfigurationSchema';

declare module 'vscode' {
	interface LanguageModelChatInformation {
		readonly configurationSchema?: DialLanguageModelConfigurationSchema;
	}
}
