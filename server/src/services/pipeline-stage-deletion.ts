import { and, asc, eq, inArray, is, or, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { pipelineCases, pipelines, pipelineStages, pipelineTransitions } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { persistActivity } from "./activity-log.js";
import { pipelineRelationScopeError, pipelineRelationChangedError, withPipelineRelationLock, samePipelineUuid } from "./pipeline-relation-scope.js";
import type { PipelineConfigurationDb } from "./pipeline-configuration.js";
import type { PipelineActor } from "./pipelines.js";

export type PipelineStageDeletionDb = PipelineConfigurationDb;
type Stage = typeof pipelineStages.$inferSelect;
type Case = typeof pipelineCases.$inferSelect;

export interface PipelineStageDeletionInput {
  companyId: string;
  pipelineId: string;
  stageId: string;
  moveCasesToStageId?: string | null;
  actor?: PipelineActor;
}

/** Trusted internal callbacks: same tx, sequential DB work, no dispatch/publication. */
export interface PipelineStageDeletionHooks {
  afterCaseMoved(tx: PipelineStageDeletionDb, move: {
    previous: Case | undefined;
    current: Case;
    stage: Stage;
    targetStage: Stage;
  }): Promise<void>;
  afterStageDeleted(tx: PipelineStageDeletionDb, stage: Stage): Promise<void>;
}

function isTerminal(kind: string | null | undefined) {
  return kind === "done" || kind === "cancelled";
}

/**
 * Caller owns the live transaction, authorization, upstream workflow scope,
 * trusted hooks and post-commit publication. No new lock protocol is enabled.
 */
export async function deletePipelineStageInTransaction(
  tx: PipelineStageDeletionDb,
  input: PipelineStageDeletionInput,
  hooks: PipelineStageDeletionHooks,
) {
  if (!is(tx, PgTransaction)) {
    throw conflict("Pipeline stage deletion requires a transaction", { code: "transaction_required" });
  }
  const actor = input.actor ?? { type: "system" };
  if (actor.type === "agent" && !actor.runId) {
    throw unprocessable("Agent pipeline mutations require a run id", { code: "run_id_required" });
  }
  const [pipeline] = await withPipelineRelationLock(() => tx.select().from(pipelines)
    .where(and(eq(pipelines.id, input.pipelineId), eq(pipelines.companyId, input.companyId)))
    .for("share", { noWait: true }));
  if (!pipeline) throw notFound("Pipeline not found");
  async function getStage(id: string, deleting = false) {
    // The source Stage will be deleted; acquire its final mode without SHARE upgrade.
    const [stage] = await withPipelineRelationLock(() => tx.select().from(pipelineStages)
      .where(and(eq(pipelineStages.id, id), eq(pipelineStages.pipelineId, pipeline.id)))
      .for(deleting ? "update" : "share", { noWait: true }));
    if (!stage) throw notFound("Pipeline stage not found");
    return stage;
  }
  const stage = await getStage(input.stageId, true);
  const targetStage = input.moveCasesToStageId ? await getStage(input.moveCasesToStageId) : null;
  if (targetStage?.id === stage.id) throw pipelineRelationScopeError();
  const candidates = await tx.select().from(pipelineCases)
    .where(eq(pipelineCases.stageId, stage.id)).orderBy(asc(pipelineCases.id));
  if (candidates.some((row) => !samePipelineUuid(row.companyId, input.companyId) || row.pipelineId !== pipeline.id)) throw pipelineRelationScopeError();
  const casesInStage = await withPipelineRelationLock(() => tx.select().from(pipelineCases)
    .where(and(eq(pipelineCases.companyId, input.companyId), eq(pipelineCases.pipelineId, pipeline.id), eq(pipelineCases.stageId, stage.id)))
    .orderBy(asc(pipelineCases.id)).for("update", { noWait: true }));
  if (candidates.map((row) => row.id).join() !== casesInStage.map((row) => row.id).join()) throw pipelineRelationChangedError();
  const edgePredicate = or(eq(pipelineTransitions.fromStageId, stage.id), eq(pipelineTransitions.toStageId, stage.id));
  const edgeCandidates = await tx.select().from(pipelineTransitions).where(edgePredicate).orderBy(asc(pipelineTransitions.id));
  if (edgeCandidates.some((row) => row.pipelineId !== pipeline.id)) throw pipelineRelationScopeError();
  const edges = await withPipelineRelationLock(() => tx.select().from(pipelineTransitions)
    .where(and(eq(pipelineTransitions.pipelineId, pipeline.id), edgePredicate)).orderBy(asc(pipelineTransitions.id))
    .for("update", { noWait: true }));
  if (edgeCandidates.map((row) => row.id).join() !== edges.map((row) => row.id).join()) throw pipelineRelationChangedError();
  for (const edge of edges) {
    await getStage(edge.fromStageId);
    await getStage(edge.toStageId);
  }
  if (casesInStage.length > 0 && !targetStage) {
    throw unprocessable("Cannot delete a stage that holds cases without moveCasesToStageId", { code: "stage_has_cases" });
  }
  let movedCaseCount = 0;
  if (targetStage) {
    const movedCases = await tx.update(pipelineCases).set({
      stageId: targetStage.id,
      version: sql`${pipelineCases.version} + 1`,
      terminalKind: isTerminal(targetStage.kind) ? targetStage.kind : null,
      terminalAt: isTerminal(targetStage.kind) ? new Date() : null,
      updatedAt: new Date(),
    }).where(and(eq(pipelineCases.companyId, input.companyId), eq(pipelineCases.pipelineId, pipeline.id), eq(pipelineCases.stageId, stage.id),
      inArray(pipelineCases.id, casesInStage.map((row) => row.id)))).returning();
    if (movedCases.map((row) => row.id).sort().join() !== casesInStage.map((row) => row.id).sort().join()) throw pipelineRelationChangedError();
    movedCaseCount = movedCases.length;
    for (const current of movedCases) {
      await hooks.afterCaseMoved(tx, {
        previous: casesInStage.find((row) => row.id === current.id), current, stage, targetStage,
      });
    }
  }
  const deletedEdges = await tx.delete(pipelineTransitions)
    .where(and(eq(pipelineTransitions.pipelineId, pipeline.id), edgePredicate)).returning({ id: pipelineTransitions.id });
  if (deletedEdges.map((row) => row.id).sort().join() !== edges.map((row) => row.id).sort().join()) throw pipelineRelationChangedError();
  const [deletedStage] = await tx.delete(pipelineStages)
    .where(and(eq(pipelineStages.pipelineId, pipeline.id), eq(pipelineStages.id, stage.id))).returning({ id: pipelineStages.id });
  if (!deletedStage) throw pipelineRelationChangedError();
  await hooks.afterStageDeleted(tx, stage);
  const actorFields = actor.type === "agent"
    ? { actorType: "agent" as const, actorId: actor.agentId, agentId: actor.agentId, runId: actor.runId }
    : actor.type === "user"
      ? { actorType: "user" as const, actorId: actor.userId }
      : { actorType: "system" as const, actorId: "pipeline-automation" };
  const { publication } = await persistActivity(tx, {
    companyId: input.companyId, ...actorFields, action: "pipeline.stage_deleted",
    entityType: "pipeline", entityId: pipeline.id,
    details: { stageId: stage.id, moveCasesToStageId: targetStage?.id ?? null, movedCaseCount },
  });
  return { result: { deleted: true as const }, publication };
}
