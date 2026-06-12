import { dialLog } from './logger';
import { type DialDeployment } from './types';

function normalizeTopic(value: string): string {
	return value.trim().toLowerCase();
}

function deploymentTopicSet(deployment: DialDeployment): ReadonlySet<string> {
	const topics = deployment.topics ?? [];
	return new Set(topics.map(normalizeTopic));
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

/** Split models by inferred {@link DialDeploymentKind}; unknown kinds are excluded with a warning. */
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
