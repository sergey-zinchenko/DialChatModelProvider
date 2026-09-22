import { dialLog } from './logger';
import { type DialDeployment } from './types';

/**
 * Cyrillic letters that look identical to Latin when someone types an English
 * tag on a Russian keyboard layout (e.g. Admin topic "Сopilot" vs setting "Copilot").
 */
const CYRILLIC_LATIN_LOOKALIKES: Readonly<Record<string, string>> = {
	А: 'A',
	а: 'a',
	В: 'B',
	Е: 'E',
	е: 'e',
	Ё: 'E',
	ё: 'e',
	К: 'K',
	к: 'k',
	М: 'M',
	м: 'm',
	Н: 'H',
	О: 'O',
	о: 'o',
	Р: 'P',
	р: 'p',
	С: 'C',
	с: 'c',
	Т: 'T',
	т: 't',
	У: 'Y',
	у: 'y',
	Х: 'X',
	х: 'x',
};

/** Fold Cyrillic lookalikes → Latin, trim, lowercase — used only for matching. */
export function normalizeTopic(value: string): string {
	let folded = '';
	for (const ch of value.trim()) {
		folded += CYRILLIC_LATIN_LOOKALIKES[ch] ?? ch;
	}
	return folded.toLowerCase();
}

function deploymentTopicSet(deployment: DialDeployment): ReadonlySet<string> {
	const topics = deployment.topics ?? [];
	return new Set(topics.map(normalizeTopic));
}

export function topicsEqual(
	a: readonly string[] | undefined,
	b: readonly string[] | undefined,
): boolean {
	const left = (a ?? [])
		.map(normalizeTopic)
		.filter((item) => item.length > 0)
		.sort();
	const right = (b ?? [])
		.map(normalizeTopic)
		.filter((item) => item.length > 0)
		.sort();
	if (left.length !== right.length) {
		return false;
	}
	return left.every((item, index) => item === right[index]);
}

/**
 * Keep models whose DIAL Topics include at least one required tag (OR match).
 * When `requiredTopics` is empty, all models pass through unchanged.
 */
export function filterByRequiredTopics(
	models: readonly DialDeployment[],
	requiredTopics: readonly string[],
): DialDeployment[] {
	const required = requiredTopics.map(normalizeTopic).filter((item) => item.length > 0);
	if (required.length === 0) {
		return [...models];
	}
	return models.filter((deployment) => {
		const topics = deploymentTopicSet(deployment);
		return required.some((topic) => topics.has(topic));
	});
}

export interface PartitionedModels {
	readonly chat: DialDeployment[];
	readonly embedding: DialDeployment[];
}

/** Split models by inferred {@link DialDeployment.kind}; unknown kinds are excluded with a warning. */
export function partitionByKind(models: readonly DialDeployment[]): PartitionedModels {
	const chat: DialDeployment[] = [];
	const embedding: DialDeployment[] = [];
	for (const deployment of models) {
		if (deployment.kind === 'chat') {
			chat.push(deployment);
		} else if (deployment.kind === 'embedding') {
			embedding.push(deployment);
		} else {
			dialLog.warn(`Model ${deployment.id} has no inferrable kind — excluded from picker`);
		}
	}
	return { chat, embedding };
}

export function summarizeModelPipeline(
	loaded: number,
	afterTopicFilter: number,
	partition: PartitionedModels,
): string {
	return (
		`Loaded ${loaded} model(s) → ${afterTopicFilter} after topic filter → ` +
		`chat=${partition.chat.length}, embedding=${partition.embedding.length}`
	);
}

/** Log why models were dropped when a topic filter is active (Output → DIAL). */
export function logTopicFilterDiagnostics(
	source: readonly DialDeployment[],
	requiredTopics: readonly string[],
	filtered: readonly DialDeployment[],
	partition: PartitionedModels,
): void {
	const required = requiredTopics.map(normalizeTopic).filter((item) => item.length > 0);
	if (required.length === 0) {
		return;
	}
	const kept = new Set(filtered.map((model) => model.id));
	for (const deployment of source) {
		if (kept.has(deployment.id)) {
			continue;
		}
		const topics = deployment.topics ?? [];
		if (topics.length === 0) {
			dialLog.info(
				`Topic filter excluded ${deployment.id}: no topics in listing (set DIAL Admin Topics / descriptionKeywords)`,
			);
			continue;
		}
		dialLog.info(
			`Topic filter excluded ${deployment.id}: topics=[${topics.join(', ')}] required=[${required.join(', ')}]`,
		);
	}
	for (const deployment of filtered) {
		if (deployment.kind !== undefined) {
			continue;
		}
		dialLog.warn(
			`Topic filter kept ${deployment.id} but kind is unknown — excluded from chat picker`,
		);
	}
	if (partition.chat.length + partition.embedding.length < filtered.length) {
		dialLog.warn(
			`${filtered.length - partition.chat.length - partition.embedding.length} model(s) matched topics but have no chat/embedding kind`,
		);
	}
}
