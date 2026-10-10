import { and, eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { companies, projects, pipelines, pipelineStages, onisallIntakeDrafts as drafts,
  onisallInputSnapshots as snapshots, onisallNativeBindings as bindings, type Db } from "@paperclipai/db";
import { createOnisallBindingSchema, onisallBindingContextSchema,
  type CreateOnisallBinding, type OnisallBindingContextInput, type OnisallBindingContext } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../../errors.js";
import { pipelineService } from "../pipelines.js";
import { accessService } from "../access.js";
import type { AuthorizationActor } from "../authorization.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import { onisallIntakeDraftService } from "./intake-drafts.js";
import { assertBindingProjectVisible, readIntakeBinding, bindingView } from "./binding-view.js";
import { sha256 } from "./input-snapshot.js";
import type { StorageService } from "../../storage/types.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function digest(value: unknown) { return sha256(Buffer.from(canonical(value), "utf8")); }

export function onisallNativeBindingService(db: Db, storage: StorageService, actor: AuthorizationActor) {
  function directBoard() {
    if (actor.type !== "board" || !actor.userId || actor.source === "mcp_oauth") throw forbidden("Direct board session required");
    return actor.userId;
  }
  async function context(tx: Tx, companyId: string, intakeId: string, input: OnisallBindingContextInput, write: boolean) {
    directBoard();
    const [company] = await tx.select().from(companies).where(eq(companies.id, companyId)).for("share");
    if (!company) throw notFound("Company not found");
    if (company.status !== "active") throw conflict("Company is not active");
    const query = tx.select().from(drafts).where(and(eq(drafts.companyId, companyId), eq(drafts.id, intakeId)));
    const [draft] = await (write ? query.for("update") : query.for("share"));
    if (!draft) throw notFound("Intake draft not found");
    const existing = await readIntakeBinding(tx, companyId, intakeId, actor);
    if (draft.bindingStatus !== (existing ? "bound" : "binding_pending")) throw conflict("Intake binding projection differs");
    const [snapshot] = await tx.select().from(snapshots)
      .where(and(eq(snapshots.companyId, companyId), eq(snapshots.id, draft.initialSnapshotId))).for("share");
    if (!snapshot) throw notFound("Input snapshot not found");
    const [pipeline] = await tx.select().from(pipelines)
      .where(and(eq(pipelines.companyId, companyId), eq(pipelines.id, input.pipelineId))).for("share");
    if (!pipeline) throw notFound("Pipeline not found");
    if (pipeline.archivedAt) throw conflict("Pipeline is archived");
    const [stage] = await tx.select().from(pipelineStages)
      .where(and(eq(pipelineStages.pipelineId, pipeline.id), eq(pipelineStages.key, input.entryStageKey))).for("share");
    if (!stage) throw notFound("Pipeline entry stage not found");
    if (stage.kind !== "working" || stage.config.disabled === true || stage.config.onEnter != null) {
      throw conflict("Preparation binding requires an enabled working entry without automation");
    }
    if (pipeline.projectId) {
      const [project] = await tx.select().from(projects)
        .where(and(eq(projects.companyId, companyId), eq(projects.id, pipeline.projectId))).for("share");
      if (!project) throw notFound("Project not found");
      await assertBindingProjectVisible(tx, companyId, project.id, actor);
      if (project.archivedAt || project.pausedAt || project.status === "cancelled" || project.status === "completed") {
        throw conflict("Project is not available for preparation");
      }
    }
    const configurationHash = digest(["onisall.binding-context.v1", {
      id: pipeline.id, companyId: pipeline.companyId, projectId: pipeline.projectId,
      enforceTransitions: pipeline.enforceTransitions, updatedAt: pipeline.updatedAt.toISOString(),
    }, { id: stage.id, key: stage.key, kind: stage.kind, config: stage.config, updatedAt: stage.updatedAt.toISOString() }]);
    return { draft, snapshot, pipeline, stage, existing, configurationHash };
  }
  return {
    async context(companyId: string, intakeId: string, input: OnisallBindingContextInput): Promise<OnisallBindingContext> {
      const data = onisallBindingContextSchema.parse(input);
      return db.transaction(async tx => {
        const state = await context(tx, companyId, intakeId, data, false);
        return { protocol: "onisall.binding-context.v1", intakeId, pipelineId: state.pipeline.id,
          projectId: state.pipeline.projectId, entryStageKey: state.stage.key, inputSha256: state.snapshot.sha256,
          configurationHash: state.configurationHash, binding: state.existing ? bindingView(state.existing) : null };
      });
    },
    async get(companyId: string, intakeId: string) {
      directBoard();
      const draft = await onisallIntakeDraftService(db, storage, actor).get(companyId, intakeId);
      return { binding: draft.binding };
    },
    async bind(companyId: string, intakeId: string, input: CreateOnisallBinding) {
      const userId = directBoard();
      const data = createOnisallBindingSchema.parse(input);
      const permission = await accessService(db).decide({ actor, action: "pipelines:write",
        resource: { type: "company", companyId }, scope: { pipelineId: data.pipelineId } });
      if (!permission.allowed) throw forbidden("Pipeline write permission required");
      // File verification precedes the DB-only composition. Recheck its identity under the intake lock.
      const verified = await onisallIntakeDraftService(db, storage, actor).content(companyId, intakeId);
      let prepared: Awaited<ReturnType<typeof context>>;
      let requestHash: string;
      let marker: Record<string, unknown>;
      const result = await pipelineService(db).ingestCaseWithRelatedRecords(async tx => {
        prepared = await context(tx, companyId, intakeId, data, true);
        if (prepared.snapshot.sha256 !== data.inputSha256 || verified.sha256 !== data.inputSha256
          || prepared.pipeline.projectId !== data.projectId || prepared.configurationHash !== data.configurationHash) {
          throw conflict("Binding input, scope or configuration changed");
        }
        requestHash = digest(["onisall.native-binding.v1", companyId, intakeId, prepared.draft.requestHash,
          prepared.snapshot.id, data]);
        if (prepared.existing && prepared.existing.requestHash !== requestHash) throw conflict("Intake already has a different binding");
        marker = { protocol: "onisall.native-binding.v1", intakeId, snapshotId: prepared.snapshot.id,
          inputSha256: data.inputSha256, requestHash, purpose: "preparation" };
        return { companyId, pipelineId: data.pipelineId, caseKey: `onisall.intake:${intakeId}`,
          title: prepared.draft.sourceLabel, summary: "需求准备绑定；尚未获得执行授权。",
          stageKey: data.entryStageKey, fields: { onisall: marker }, actor: { type: "user", userId } };
      }, async (tx, ingest) => {
        if (ingest.automationLedger || !isDeepStrictEqual(ingest.case.fields.onisall, marker)
          || ingest.case.companyId !== companyId || ingest.case.pipelineId !== data.pipelineId || ingest.case.retiredAt) {
          throw conflict("Native Case relationship differs");
        }
        if (prepared.existing) {
          if (ingest.created || prepared.existing.caseId !== ingest.case.id) throw conflict("Native Case binding differs");
          return { binding: bindingView(prepared.existing), replayed: true, publication: null };
        }
        if (!ingest.created) throw conflict("Native Case exists without the expected binding");
        const [row] = await tx.insert(bindings).values({ companyId, intakeId, snapshotId: prepared.snapshot.id,
          inputSha256: data.inputSha256, pipelineId: data.pipelineId, projectId: data.projectId,
          caseId: ingest.case.id, entryStageKey: data.entryStageKey, configurationHash: data.configurationHash,
          requestHash, createdByUserId: userId }).returning();
        await tx.update(drafts).set({ bindingStatus: "bound" }).where(and(eq(drafts.companyId, companyId), eq(drafts.id, intakeId)));
        const { publication } = await persistActivity(tx as unknown as Db, { companyId, actorType: "user", actorId: userId,
          action: "onisall.intake.bound", entityType: "onisall_intake_draft", entityId: intakeId,
          details: { bindingId: row!.id, caseId: ingest.case.id, preparationOnly: true } });
        return { binding: bindingView(row!), replayed: false, publication };
      });
      if (result.related.publication) publishActivity(result.related.publication);
      return { binding: result.related.binding, replayed: result.related.replayed };
    },
  };
}
