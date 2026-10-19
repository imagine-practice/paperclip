import { and, eq, is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { pipelines, pipelineStages, pipelineTransitions, type Db } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import type { PipelineActor } from "./pipelines.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Compatible with CompanyWorkflowDb; no root transaction or isolation API. */
export type PipelineConfigurationDb = Omit<Transaction, "transaction" | "setTransaction">;

export interface PipelineMetadataPatch {
  name?: string;
  description?: string | null;
  enforceTransitions?: boolean;
  archived?: boolean;
}

interface MutationScope {
  companyId: string;
  pipelineId: string;
  actor: PipelineActor;
}

export interface PipelineMetadataMutation extends MutationScope {
  patch: PipelineMetadataPatch;
}

export interface PipelineTransitionsMutation extends MutationScope {
  transitions: Array<{ fromStageKey: string; toStageKey: string; label?: string | null }>;
  enforceTransitions?: boolean;
}

function requireTransaction(tx: PipelineConfigurationDb) {
  if (!is(tx, PgTransaction)) {
    throw conflict("Pipeline configuration composition requires a transaction", { code: "transaction_required" });
  }
}

function activityActor(actor: PipelineActor) {
  if (actor.type === "agent") {
    if (!actor.runId) throw unprocessable("Agent pipeline mutations require a run id", { code: "run_id_required" });
    return { actorType: "agent" as const, actorId: actor.agentId, agentId: actor.agentId, runId: actor.runId };
  }
  if (actor.type === "user") return { actorType: "user" as const, actorId: actor.userId };
  return { actorType: "system" as const, actorId: "pipeline-configuration" };
}

async function lockPipeline(tx: PipelineConfigurationDb, scope: MutationScope) {
  const [pipeline] = await tx.select().from(pipelines)
    .where(and(eq(pipelines.companyId, scope.companyId), eq(pipelines.id, scope.pipelineId)))
    .for("no key update");
  if (!pipeline) throw notFound("Pipeline not found");
  return pipeline;
}

/**
 * Trusted DB-only composition. Caller owns transaction, route authorization,
 * future upstream workflow entry, and post-commit publication. A real tx is
 * necessary; it is not evidence that every workflow writer is participating.
 */
export async function updatePipelineConfigurationInTransaction(tx: PipelineConfigurationDb, input: PipelineMetadataMutation) {
  requireTransaction(tx);
  const actor = activityActor(input.actor);
  const pipeline = await lockPipeline(tx, input);
  const patch: Partial<typeof pipelines.$inferInsert> = { updatedAt: new Date() };
  if (input.patch.name !== undefined) patch.name = input.patch.name;
  if (input.patch.description !== undefined) patch.description = input.patch.description;
  if (input.patch.enforceTransitions !== undefined) patch.enforceTransitions = input.patch.enforceTransitions;
  if (input.patch.archived !== undefined) patch.archivedAt = input.patch.archived ? new Date() : null;
  const [updated] = await tx.update(pipelines).set(patch)
    .where(and(eq(pipelines.companyId, input.companyId), eq(pipelines.id, pipeline.id))).returning();
  if (!updated) throw notFound("Pipeline not found");
  const { publication } = await persistActivity(tx, {
    companyId: input.companyId, ...actor, action: "pipeline.updated", entityType: "pipeline", entityId: pipeline.id,
    details: { fields: Object.keys(patch).filter((key) => key !== "updatedAt") },
  });
  return { pipeline: updated, publication };
}

/** Serialize whole-set replacements on the parent before inspecting any edge. */
export async function replacePipelineTransitionsInTransaction(tx: PipelineConfigurationDb, input: PipelineTransitionsMutation) {
  requireTransaction(tx);
  const actor = activityActor(input.actor);
  if (input.transitions.length > 500) throw unprocessable("Transitions support at most 500 edges", { code: "validation" });
  const pipeline = await lockPipeline(tx, input);
  const stages = await tx.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipeline.id));
  const byKey = new Map(stages.map((stage) => [stage.key, stage]));
  const transitions = input.transitions.map((edge) => {
    const from = byKey.get(edge.fromStageKey);
    const to = byKey.get(edge.toStageKey);
    if (!from || !to) throw unprocessable("Transition references unknown stage", { code: "validation" });
    return { pipelineId: pipeline.id, fromStageId: from.id, toStageId: to.id, label: edge.label ?? null };
  });
  await tx.delete(pipelineTransitions).where(eq(pipelineTransitions.pipelineId, pipeline.id));
  if (input.enforceTransitions !== undefined) {
    await tx.update(pipelines).set({ enforceTransitions: input.enforceTransitions, updatedAt: new Date() })
      .where(and(eq(pipelines.companyId, input.companyId), eq(pipelines.id, pipeline.id)));
  }
  const rows = transitions.length ? await tx.insert(pipelineTransitions).values(transitions).returning() : [];
  const { publication } = await persistActivity(tx, {
    companyId: input.companyId, ...actor, action: "pipeline.transitions_replaced", entityType: "pipeline", entityId: pipeline.id,
    details: { transitionCount: rows.length, enforceTransitionsProvided: input.enforceTransitions !== undefined },
  });
  return { transitions: rows, publication };
}

/** Notification failure cannot turn an already committed configuration into a failure. */
export function publishPipelineConfigurationActivity(publication: ActivityPublication) {
  try { publishActivity(publication); }
  catch (error) { logger.warn({ err: error, companyId: publication.companyId }, "Pipeline configuration committed; activity publication failed"); }
}
