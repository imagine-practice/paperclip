import type { pipelines, pipelineStages, pipelineTransitions } from "@paperclipai/db";
import { sha256 } from "./input-snapshot.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function bindingDigest(value: unknown): string {
  return sha256(Buffer.from(canonical(value), "utf8"));
}
type Pipeline = typeof pipelines.$inferSelect;
type Stage = typeof pipelineStages.$inferSelect;
type Transition = typeof pipelineTransitions.$inferSelect;
function pipelineIdentity(pipeline: Pipeline) {
  return { id: pipeline.id, companyId: pipeline.companyId, projectId: pipeline.projectId,
    enforceTransitions: pipeline.enforceTransitions, updatedAt: pipeline.updatedAt.toISOString() };
}
function stageIdentity(stage: Stage) {
  return { id: stage.id, key: stage.key, kind: stage.kind, config: stage.config, updatedAt: stage.updatedAt.toISOString() };
}
/** Preserve ONS-0011's exact preparation configuration hash protocol. */
export function bindingConfigurationHash(pipeline: Pipeline, stage: Stage): string {
  return bindingDigest(["onisall.binding-context.v1", pipelineIdentity(pipeline), stageIdentity(stage)]);
}
/** Current workflow observation. Existing bindings do not freeze this hash. */
export function serializeWorkflowConfiguration(pipeline: Pipeline, stages: Stage[], transitions: Transition[]): string {
  return canonical(["onisall.workflow-observation.v1", { ...pipelineIdentity(pipeline), key: pipeline.key,
    name: pipeline.name, description: pipeline.description, archivedAt: pipeline.archivedAt?.toISOString() ?? null },
    [...stages].sort((a, b) => a.id.localeCompare(b.id)).map(stage => ({ ...stageIdentity(stage), name: stage.name, position: stage.position })),
    [...transitions].sort((a, b) => a.id.localeCompare(b.id)).map(edge => ({ id: edge.id,
      fromStageId: edge.fromStageId, toStageId: edge.toStageId, label: edge.label, updatedAt: edge.updatedAt.toISOString() }))]);
}
export function workflowConfigurationHash(pipeline: Pipeline, stages: Stage[], transitions: Transition[]): string {
  return sha256(Buffer.from(serializeWorkflowConfiguration(pipeline, stages, transitions), "utf8"));
}
