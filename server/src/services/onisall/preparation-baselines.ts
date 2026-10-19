import { and, eq, sql } from "drizzle-orm";
import { onisallPreparationBaselines as baselines, type Db } from "@paperclipai/db";
import type { OnisallPreparationBaseline, OnisallPreparationBaselineStatus, OnisallPreparationStatus } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { readPipelineCaseInTransaction } from "../pipelines.js";
import { persistActivity } from "../activity-log.js";
import type { AuthorizationActor } from "../authorization.js";
import { assertBindingProjectVisible } from "./binding-view.js";
import { revalidateNativeBindingInTransaction } from "./native-revalidation.js";
import { bindingDigest, serializeWorkflowConfiguration } from "./binding-configuration.js";
import { sha256 } from "./input-snapshot.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Row = typeof baselines.$inferSelect;
type Identity = Pick<Row, "companyId" | "intakeId" | "bindingId" | "bindingRevision" | "snapshotId" | "inputSha256"
  | "caseId" | "caseVersion" | "pipelineId" | "projectId" | "stageId" | "stageKey" | "bindingConfigurationHash" | "workflowHash">;
export function preparationBaselineHash(row: Identity): string {
  const { companyId, intakeId, bindingId, bindingRevision, snapshotId, inputSha256, caseId, caseVersion,
    pipelineId, projectId, stageId, stageKey, bindingConfigurationHash, workflowHash } = row;
  return bindingDigest(["onisall.preparation-baseline.v1", { companyId, intakeId, bindingId, bindingRevision, snapshotId,
    inputSha256, caseId, caseVersion, pipelineId, projectId, stageId, stageKey, bindingConfigurationHash, workflowHash }]);
}
function baselineView(row: Row): OnisallPreparationBaseline {
  if (sha256(Buffer.from(row.workflowSnapshot, "utf8")) !== row.workflowHash || preparationBaselineHash(row) !== row.baselineHash
    || row.purpose !== "preparation" || row.executionAdmission !== "not_granted" || row.bindingRevision !== 1) {
    throw conflict("Stored preparation baseline differs");
  }
  return { protocol: "onisall.preparation-baseline.v1", id: row.id, companyId: row.companyId, intakeId: row.intakeId,
    bindingId: row.bindingId, bindingRevision: 1, snapshotId: row.snapshotId, inputSha256: row.inputSha256,
    caseId: row.caseId, caseVersion: row.caseVersion, pipelineId: row.pipelineId, projectId: row.projectId,
    stageId: row.stageId, stageKey: row.stageKey, bindingConfigurationHash: row.bindingConfigurationHash,
    workflowHash: row.workflowHash, baselineHash: row.baselineHash, purpose: "preparation",
    executionAdmission: "not_granted", createdAt: row.createdAt.toISOString() };
}
export async function readPreparationBaselineInTransaction(tx: Tx, companyId: string, intakeId: string,
  baselineId: string, actor: AuthorizationActor) {
  const [row] = await tx.select().from(baselines).where(and(eq(baselines.companyId, companyId), eq(baselines.intakeId, intakeId), eq(baselines.id, baselineId)));
  if (!row) throw notFound("Preparation baseline not found");
  await assertBindingProjectVisible(tx, companyId, row.projectId, actor);
  return baselineView(row);
}
/** Caller verifies source bytes and authorization in this DB snapshot. */
export async function createPreparationBaselineInTransaction(tx: Tx, preparation: OnisallPreparationStatus,
  actor: AuthorizationActor, userId: string, requestKey: string) {
  const { companyId, intakeId, input } = preparation;
  // Serialize this operation's keys only. This is not a native workflow lock
  // or a publication fence; concurrent native changes may make it historical.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`onisall-baseline:${companyId}:${intakeId}:${requestKey}`}, 0))`);
  const [existing] = await tx.select().from(baselines).where(and(eq(baselines.companyId, companyId),
    eq(baselines.intakeId, intakeId), eq(baselines.requestKey, requestKey)));
  if (existing) {
    await assertBindingProjectVisible(tx, companyId, existing.projectId, actor);
    return { baseline: baselineView(existing), replayed: true, publication: null };
  }
  const native = await revalidateNativeBindingInTransaction(tx, companyId, intakeId, actor, input);
  if (native.status !== "consistent") throw conflict("Native preparation is not available for freezing");
  const current = await readPipelineCaseInTransaction(tx, companyId, native.head.caseId);
  const workflowSnapshot = serializeWorkflowConfiguration(current.pipeline, current.stages, current.transitions);
  if (Buffer.byteLength(workflowSnapshot, "utf8") > 1024 * 1024) throw unprocessable("Preparation workflow exceeds snapshot limit");
  const identity: Identity = { companyId, intakeId, bindingId: native.bindingId, bindingRevision: native.bindingRevision,
    snapshotId: input.snapshotId, inputSha256: input.sha256, caseId: native.head.caseId,
    pipelineId: native.head.pipelineId, projectId: native.head.projectId, stageId: native.head.stageId, stageKey: native.head.stageKey,
    caseVersion: native.head.version, bindingConfigurationHash: native.configuration.bindingHash,
    workflowHash: native.configuration.workflowHash };
  if (sha256(Buffer.from(workflowSnapshot, "utf8")) !== identity.workflowHash) throw conflict("Preparation workflow differs");
  const [row] = await tx.insert(baselines).values({ ...identity, workflowSnapshot,
    baselineHash: preparationBaselineHash(identity), requestKey, createdByUserId: userId }).returning();
  const { publication } = await persistActivity(tx as unknown as Db, { companyId, actorType: "user", actorId: userId,
    action: "onisall.preparation_baseline.created", entityType: "onisall_preparation_baseline", entityId: row!.id,
    details: { intakeId, baselineHash: row!.baselineHash, preparationOnly: true } });
  return { baseline: baselineView(row!), replayed: false, publication };
}
export async function preparationBaselineStatusInTransaction(tx: Tx, preparation: OnisallPreparationStatus,
  actor: AuthorizationActor, baselineId: string): Promise<OnisallPreparationBaselineStatus> {
  const { companyId, intakeId, input } = preparation;
  const [row] = await tx.select().from(baselines).where(and(eq(baselines.companyId, companyId), eq(baselines.intakeId, intakeId), eq(baselines.id, baselineId)));
  if (!row) throw notFound("Preparation baseline not found");
  await assertBindingProjectVisible(tx, companyId, row.projectId, actor);
  const baseline = baselineView(row);
  const native = await revalidateNativeBindingInTransaction(tx, companyId, intakeId, actor, input);
  const changes: OnisallPreparationBaselineStatus["comparison"]["changes"] = [];
  if (baseline.snapshotId !== input.snapshotId || baseline.inputSha256 !== input.sha256) changes.push("input_changed");
  if (native.status === "pending") changes.push("native_pending");
  else {
    if (native.status === "blocked") changes.push("native_blocked");
    if (native.bindingId !== baseline.bindingId || native.bindingRevision !== baseline.bindingRevision) changes.push("binding_changed");
    if (native.head.caseId !== baseline.caseId || native.head.version !== baseline.caseVersion
      || native.head.stageId !== baseline.stageId || native.head.stageKey !== baseline.stageKey) changes.push("case_head_changed");
    if (native.configuration.workflowHash !== baseline.workflowHash) changes.push("workflow_changed");
  }
  return { protocol: "onisall.preparation-baseline-status.v1", evaluatedAt: new Date().toISOString(), diagnosticsOnly: true,
    baseline, comparison: { status: changes.length ? "changed" : "matches", changes }, native, publication: preparation.publication };
}
