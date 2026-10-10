import { and, eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { onisallNativeBindings as bindings, onisallIntakeDrafts as drafts, projects, type Db } from "@paperclipai/db";
import type { OnisallPreparationStatus, OnisallNativeRevalidation, OnisallNativeRevalidationBlocker } from "@paperclipai/shared";
import { conflict, notFound } from "../../errors.js";
import { readPipelineCaseInTransaction } from "../pipelines.js";
import type { AuthorizationActor } from "../authorization.js";
import { assertBindingProjectVisible } from "./binding-view.js";
import { bindingDigest, bindingConfigurationHash, workflowConfigurationHash } from "./binding-configuration.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Trusted DB-only composition: input must have been verified in the same
 * snapshot by the caller. Future publication must reread under its own locks;
 * an HTTP response is never accepted as this function's input. */
export async function revalidateNativeBindingInTransaction(tx: Tx, companyId: string, intakeId: string,
  actor: AuthorizationActor, input: OnisallPreparationStatus["input"]): Promise<OnisallNativeRevalidation["native"]> {
  const [draft] = await tx.select().from(drafts).where(and(eq(drafts.companyId, companyId), eq(drafts.id, intakeId)));
  if (!draft) throw notFound("Intake draft not found");
  const [binding] = await tx.select().from(bindings).where(and(eq(bindings.companyId, companyId), eq(bindings.intakeId, intakeId)));
  if (draft.initialSnapshotId !== input.snapshotId || draft.bindingStatus !== (binding ? "bound" : "binding_pending")) {
    throw conflict("Intake binding projection differs");
  }
  if (!binding) return { status: "pending" };
  await assertBindingProjectVisible(tx, companyId, binding.projectId, actor);
  const requestHash = bindingDigest(["onisall.native-binding.v1", companyId, intakeId, draft.requestHash,
    binding.snapshotId, { pipelineId: binding.pipelineId, entryStageKey: binding.entryStageKey,
      projectId: binding.projectId, inputSha256: binding.inputSha256, configurationHash: binding.configurationHash }]);
  if (binding.snapshotId !== input.snapshotId || binding.inputSha256 !== input.sha256 || requestHash !== binding.requestHash
    || binding.revision !== 1 || binding.purpose !== "preparation" || binding.executionAdmission !== "not_granted") {
    throw conflict("Native binding input differs");
  }
  const native = await readPipelineCaseInTransaction(tx, companyId, binding.caseId);
  // A Pipeline's Project can change independently of the recorded binding.
  // Check both privacy scopes before exposing any current native information.
  await assertBindingProjectVisible(tx, companyId, native.pipeline.projectId, actor);
  const row = native.case;
  const marker = { protocol: "onisall.native-binding.v1", intakeId, snapshotId: binding.snapshotId,
    inputSha256: binding.inputSha256, requestHash: binding.requestHash, purpose: "preparation" };
  if (row.pipelineId !== binding.pipelineId || native.pipeline.id !== binding.pipelineId
    || native.pipeline.projectId !== binding.projectId || native.stage.pipelineId !== binding.pipelineId
    || row.caseKey !== `onisall.intake:${intakeId}` || !isDeepStrictEqual(row.fields.onisall, marker)
    || !Number.isSafeInteger(row.version) || row.version < 1) {
    throw conflict("Native Case relationship differs");
  }
  const blockers: OnisallNativeRevalidationBlocker[] = [];
  if (native.pipeline.archivedAt) blockers.push("pipeline_archived");
  if (row.retiredAt) blockers.push("case_retired");
  if (row.terminalKind || native.stage.kind === "done" || native.stage.kind === "cancelled") blockers.push("case_terminal");
  if (native.stage.key !== binding.entryStageKey) blockers.push("case_left_entry_stage");
  const entry = native.stages.find(stage => stage.key === binding.entryStageKey);
  if (!entry) blockers.push("entry_stage_missing");
  else if (entry.kind !== "working" || entry.config.disabled === true || entry.config.onEnter != null) blockers.push("entry_stage_unavailable");
  if (native.stage.kind !== "working" || native.stage.config.disabled === true || native.stage.config.onEnter != null) {
    blockers.push("current_stage_unavailable");
  }
  const currentBindingHash = entry ? bindingConfigurationHash(native.pipeline, entry) : null;
  if (currentBindingHash !== binding.configurationHash) blockers.push("preparation_configuration_changed");
  if (native.hasAutomationExecution) blockers.push("automation_execution_exists");
  if (binding.projectId) {
    const [project] = await tx.select().from(projects).where(and(eq(projects.companyId, companyId), eq(projects.id, binding.projectId)));
    if (!project) throw notFound("Project not found");
    if (project.archivedAt) blockers.push("project_archived");
    if (project.pausedAt) blockers.push("project_paused");
    if (project.status === "cancelled" || project.status === "completed") blockers.push("project_terminal");
  }
  return { status: blockers.length ? "blocked" : "consistent", blockers, bindingId: binding.id, bindingRevision: 1,
    head: { caseId: row.id, version: row.version, pipelineId: row.pipelineId, projectId: binding.projectId,
      stageId: native.stage.id, stageKey: native.stage.key, stageKind: native.stage.kind,
      retired: row.retiredAt !== null, terminalKind: row.terminalKind },
    configuration: { status: currentBindingHash === binding.configurationHash ? "matches_binding" : "changed",
      bindingHash: binding.configurationHash, currentBindingHash,
      workflowHash: workflowConfigurationHash(native.pipeline, native.stages, native.transitions), workflowBaseline: "not_frozen" } };
}
