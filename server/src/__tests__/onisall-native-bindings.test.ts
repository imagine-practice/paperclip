import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, companies, projects, projectAccessMembers, pipelines, pipelineStages, pipelineCases, pipelineCaseEvents,
  pipelineAutomationExecutions, documents, activityLog, issues, routines, routineRuns, heartbeatRuns,
  pipelineTransitions, onisallIntakeDrafts, onisallInputObservations, onisallInputSnapshots, onisallNativeBindings,
  onisallPreparationBaselines, onisallFrozenSchemaSetMembers, onisallFrozenSchemaSets, onisallSchemaVersions } from "@paperclipai/db";
import type { CreateOnisallBinding, OnisallBindingContext } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { onisallNativeBindingService } from "../services/onisall/native-bindings.js";
import { onisallIntakeDraftService } from "../services/onisall/intake-drafts.js";
import { pipelineService } from "../services/pipelines.js";
import { companyService } from "../services/companies.js";
import { onisallFrozenSchemaSetService } from "../services/onisall/frozen-schema-sets.js";
import { createOfflineSchemaRegistry } from "../services/onisall/schema-registry.js";
import type { StorageService } from "../storage/types.js";
import type { AuthorizationActor } from "../services/authorization.js";

const support = await getEmbeddedPostgresTestSupport();
const actor: AuthorizationActor = { type: "board", source: "local_implicit", userId: "owner" };
function request(context: OnisallBindingContext): CreateOnisallBinding {
  const { pipelineId, projectId, entryStageKey, inputSha256, configurationHash } = context;
  return { pipelineId, projectId, entryStageKey, inputSha256, configurationHash };
}
(support.supported ? describe : describe.skip)("OnisAll native binding with real temporary PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const blobs = new Map<string, Buffer>();
  let beforeRead: (() => Promise<void>) | undefined;
  const storage: StorageService = {
    provider: "local_disk",
    async putFile(input) {
      if (!Buffer.isBuffer(input.body)) throw new Error("Expected buffer fixture");
      blobs.set(input.objectKey!, Buffer.from(input.body));
      return { provider: "local_disk", objectKey: input.objectKey!, byteSize: input.body.length,
        sha256: createHash("sha256").update(input.body).digest("hex"), contentType: input.contentType,
        originalFilename: input.originalFilename };
    },
    async getObject(_company, key) {
      await beforeRead?.();
      return { stream: Readable.from([blobs.get(key)!]) };
    },
    async headObject() { throw new Error("Not used"); },
    async deleteObject() { throw new Error("Unexpected deletion"); },
  };
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("paperclip-onisall-binding-");
    db = createDb(fixture.connectionString);
  }, 30_000);
  afterEach(async () => {
    beforeRead = undefined;
    // Dedicated test database only, never the development instance.
    await db.delete(onisallFrozenSchemaSetMembers);
    await db.delete(onisallFrozenSchemaSets);
    await db.delete(onisallSchemaVersions);
    await db.delete(onisallPreparationBaselines);
    await db.delete(onisallNativeBindings);
    await db.delete(onisallInputObservations);
    await db.delete(onisallIntakeDrafts);
    await db.delete(onisallInputSnapshots);
    await db.delete(pipelineAutomationExecutions);
    await db.delete(pipelines);
    await db.delete(documents);
    await db.delete(activityLog);
    await db.delete(routineRuns);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(routines);
    await db.delete(projects);
    await db.delete(companies);
    blobs.clear();
  });
  afterAll(async () => { await fixture?.cleanup(); });
  async function setup(withProject = false) {
    const [company] = await db.insert(companies).values({ name: "Binding fixture", issuePrefix: `Q${randomUUID().slice(0, 7)}`,
      defaultResponsibleUserId: "owner" }).returning();
    const project = withProject ? (await db.insert(projects).values({ companyId: company!.id, name: "Private project",
      visibility: "private", privacyOwnerUserId: "owner" }).returning())[0]! : null;
    if (project) await db.insert(projectAccessMembers).values({ companyId: company!.id, projectId: project.id, subjectType: "user", subjectId: "owner" });
    const native = pipelineService(db, { heartbeat: { wakeup: async () => null } });
    const pipeline = await native.createPipeline({ companyId: company!.id, key: "binding", name: "Binding",
      projectId: project?.id ?? null, actor: { type: "user", userId: "owner" } });
    const intakeSvc = onisallIntakeDraftService(db, storage, actor);
    const input = { requestKey: "fixture", goal: "Prepare a traceable requirement", sourceLabel: "Synthetic input",
      contentBase64: Buffer.from("Synthetic\r\ninput\n").toString("base64") };
    const { draft } = await intakeSvc.create(company!.id, "owner", input);
    const service = onisallNativeBindingService(db, storage, actor);
    const context = await service.context(company!.id, draft.id, { pipelineId: pipeline.id, entryStageKey: "intake" });
    return { company: company!, project, pipeline, draft, service, native, intakeSvc, input, request: request(context) };
  }
  async function freeze() {
    const f = await setup(true);
    const { binding } = await f.service.bind(f.company.id, f.draft.id, f.request);
    const { baseline } = await f.intakeSvc.createPreparationBaseline(f.company.id, f.draft.id, { requestKey: "baseline" });
    return { ...f, binding, baseline };
  }
  it("native company removal cleans frozen rules and baselines before their dependencies, preserving the other company", async () => {
    const f = await freeze(), other = await freeze();
    const bytes = Buffer.from(JSON.stringify({ type: "null" }));
    const ref = { registry_key: "fixture/null", revision: "1", sha256: createHash("sha256").update(bytes).digest("hex") };
    const registry = createOfflineSchemaRegistry([{ ref, bytes }]);
    const schemas = onisallFrozenSchemaSetService(db, actor);
    await schemas.freeze(f.company.id, registry, [ref]);
    const retained = await schemas.freeze(other.company.id, registry, [ref]);
    // Native destructive service exercised only against this dedicated temporary DB.
    expect(await companyService(db).remove(f.company.id)).toMatchObject({ id: f.company.id });
    for (const table of [onisallFrozenSchemaSetMembers, onisallFrozenSchemaSets, onisallSchemaVersions,
      onisallPreparationBaselines, onisallNativeBindings, onisallIntakeDrafts, onisallInputSnapshots, projects]) {
      expect(await db.select().from(table).where(eq(table.companyId, f.company.id))).toHaveLength(0);
    }
    expect((await schemas.get(other.company.id, retained.set.id)).integrity).toBe("verified");
    expect((await other.intakeSvc.preparationBaselineStatus(other.company.id, other.draft.id, other.baseline.id)).comparison.status).toBe("matches");
    expect(await db.select().from(onisallPreparationBaselines)).toHaveLength(1);
    expect(await companyService(db).remove(f.company.id)).toBeNull();
  });
  it("persists complete workflow bytes and audit, without changing native authority", async () => {
    const f = await freeze();
    const [row] = await db.select().from(onisallPreparationBaselines);
    expect(createHash("sha256").update(row!.workflowSnapshot).digest("hex")).toBe(f.baseline.workflowHash);
    const snapshot = JSON.parse(row!.workflowSnapshot) as unknown[];
    expect(snapshot[0]).toBe("onisall.workflow-observation.v1");
    expect((snapshot[2] as unknown[]).length).toBe((await db.select().from(pipelineStages)).length);
    expect((snapshot[3] as unknown[]).length).toBe((await db.select().from(pipelineTransitions)).length);
    expect(f.baseline).toMatchObject({ caseVersion: 1, stageKey: "intake", purpose: "preparation", executionAdmission: "not_granted" });
    const logs = await db.select().from(activityLog).where(eq(activityLog.entityId, f.baseline.id));
    expect(logs).toHaveLength(1); expect(logs[0]!.action).toBe("onisall.preparation_baseline.created");
    const tables = [pipelineCases, pipelineCaseEvents, onisallNativeBindings, onisallInputObservations,
      pipelineAutomationExecutions, issues, heartbeatRuns, activityLog, onisallPreparationBaselines];
    const before = await Promise.all(tables.map(table => db.select().from(table)));
    const status = await f.intakeSvc.preparationBaselineStatus(f.company.id, f.draft.id, f.baseline.id);
    expect(status).toMatchObject({ diagnosticsOnly: true, comparison: { status: "matches", changes: [] },
      native: { status: "consistent" }, publication: { status: "unavailable", executionAdmission: "not_granted" } });
    for (const key of ["workflowSnapshot", "requestKey", "fields", "leaseToken", "goal", "sourceLabel", "objectKey", "contentBase64", "createdByUserId"]) {
      expect(JSON.stringify(status)).not.toContain(`"${key}"`);
    }
    expect(await Promise.all(tables.map(table => db.select().from(table)))).toEqual(before);
    expect((await f.intakeSvc.get(f.company.id, f.draft.id)).contractId).toBeNull();
  });
  it("serializes concurrent request keys to one observation and one audit", async () => {
    const f = await setup();
    await f.service.bind(f.company.id, f.draft.id, f.request);
    const results = await Promise.all(Array.from({ length: 4 }, () => f.intakeSvc.createPreparationBaseline(
      f.company.id, f.draft.id, { requestKey: "same-key" })));
    expect(results.filter(r => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map(r => r.baseline.id)).size).toBe(1);
    expect(await db.select().from(onisallPreparationBaselines)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "onisall.preparation_baseline.created"))).toHaveLength(1);
  });
  it.each(["other_stage", "transition", "pipeline_name", "case_version"])("detects %s changes and preserves original keyed replay", async change => {
    const f = await freeze();
    if (change === "other_stage") await db.update(pipelineStages).set({ config: { autonomy: "manual" } })
      .where(and(eq(pipelineStages.pipelineId, f.pipeline.id), eq(pipelineStages.key, "in_progress")));
    if (change === "transition") await db.update(pipelineTransitions).set({ label: "Changed edge" }).where(eq(pipelineTransitions.pipelineId, f.pipeline.id));
    if (change === "pipeline_name") await db.update(pipelines).set({ name: "Renamed" }).where(eq(pipelines.id, f.pipeline.id));
    if (change === "case_version") await db.update(pipelineCases).set({ version: 2 }).where(eq(pipelineCases.id, f.binding.caseId));
    const result = await f.intakeSvc.preparationBaselineStatus(f.company.id, f.draft.id, f.baseline.id);
    expect(result.comparison).toEqual({ status: "changed", changes: [change === "case_version" ? "case_head_changed" : "workflow_changed"] });
    expect(result.native.status).toBe("consistent");
    expect(await f.intakeSvc.createPreparationBaseline(f.company.id, f.draft.id, { requestKey: "baseline" }))
      .toEqual({ baseline: f.baseline, replayed: true });
    const next = await f.intakeSvc.createPreparationBaseline(f.company.id, f.draft.id, { requestKey: "new-observation" });
    expect(next.baseline.id).not.toBe(f.baseline.id); expect(next.baseline.baselineHash).not.toBe(f.baseline.baselineHash);
    expect((await f.intakeSvc.preparationBaselineStatus(f.company.id, f.draft.id, next.baseline.id)).comparison.status).toBe("matches");
  });
  it.each(["archive", "retire", "move", "disable", "project_pause"])("reports unavailable %s and refuses a new baseline", async change => {
    const f = await freeze();
    if (change === "archive") await db.update(pipelines).set({ archivedAt: new Date() }).where(eq(pipelines.id, f.pipeline.id));
    if (change === "retire") await db.update(pipelineCases).set({ retiredAt: new Date() }).where(eq(pipelineCases.id, f.binding.caseId));
    if (change === "move") await f.native.transitionCase({ companyId: f.company.id, caseId: f.binding.caseId,
      toStageKey: "in_progress", expectedVersion: 1, actor: { type: "user", userId: "owner" } });
    if (change === "disable") await db.update(pipelineStages).set({ config: { disabled: true } })
      .where(and(eq(pipelineStages.pipelineId, f.pipeline.id), eq(pipelineStages.key, "intake")));
    if (change === "project_pause") await db.update(projects).set({ pausedAt: new Date() }).where(eq(projects.id, f.project!.id));
    const result = await f.intakeSvc.preparationBaselineStatus(f.company.id, f.draft.id, f.baseline.id);
    expect(result.comparison.status).toBe("changed"); expect(result.comparison.changes).toContain("native_blocked");
    expect((await f.intakeSvc.createPreparationBaseline(f.company.id, f.draft.id, { requestKey: "baseline" })).baseline).toEqual(f.baseline);
    await expect(f.intakeSvc.createPreparationBaseline(f.company.id, f.draft.id, { requestKey: "new" })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(onisallPreparationBaselines)).toHaveLength(1);
  });
  it("rejects pending, damaged source and stored baseline tampering without a silent repair", async () => {
    const f = await setup();
    await expect(f.intakeSvc.createPreparationBaseline(f.company.id, f.draft.id, { requestKey: "pending" })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(onisallPreparationBaselines)).toHaveLength(0);
    await f.service.bind(f.company.id, f.draft.id, f.request);
    const { baseline } = await f.intakeSvc.createPreparationBaseline(f.company.id, f.draft.id, { requestKey: "good" });
    const [snapshot] = await db.select().from(onisallInputSnapshots);
    const original = blobs.get(snapshot!.objectKey)!; blobs.set(snapshot!.objectKey, Buffer.from("damaged"));
    await expect(f.intakeSvc.preparationBaselineStatus(f.company.id, f.draft.id, baseline.id)).rejects.toMatchObject({ status: 409 });
    await expect(f.intakeSvc.createPreparationBaseline(f.company.id, f.draft.id, { requestKey: "good" })).rejects.toMatchObject({ status: 409 });
    blobs.set(snapshot!.objectKey, original);
    await db.update(onisallPreparationBaselines).set({ workflowSnapshot: "{}" });
    await expect(f.intakeSvc.preparationBaselineStatus(f.company.id, f.draft.id, baseline.id)).rejects.toMatchObject({ status: 409 });
    await expect(f.intakeSvc.createPreparationBaseline(f.company.id, f.draft.id, { requestKey: "good" })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "onisall.preparation_baseline.created"))).toHaveLength(1);
  });
  it("enforces database reference scope, preparation shape and workflow size limit", async () => {
    const f = await freeze();
    for (const patch of [{ companyId: randomUUID() }, { snapshotId: randomUUID() }, { bindingId: randomUUID() },
      { caseId: randomUUID() }, { projectId: randomUUID() }, { pipelineId: randomUUID() }, { caseVersion: 0 },
      { executionAdmission: "granted" }, { requestKey: "bad key" }, { workflowSnapshot: "x".repeat(1024 * 1024 + 1) }]) {
      await expect(db.update(onisallPreparationBaselines).set(patch)).rejects.toBeDefined();
    }
    await db.update(pipelineStages).set({ config: { note: "x".repeat(1024 * 1024) } })
      .where(and(eq(pipelineStages.pipelineId, f.pipeline.id), eq(pipelineStages.key, "in_progress")));
    await expect(f.intakeSvc.createPreparationBaseline(f.company.id, f.draft.id, { requestKey: "oversized" })).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(onisallPreparationBaselines)).toHaveLength(1);
  });
  it("hides foreign company/intake and private Project baselines and denies viewer mutation", async () => {
    const f = await freeze();
    await expect(f.intakeSvc.preparationBaselineStatus(randomUUID(), f.draft.id, f.baseline.id)).rejects.toMatchObject({ status: 404 });
    await expect(f.intakeSvc.preparationBaselineStatus(f.company.id, f.draft.id, randomUUID())).rejects.toMatchObject({ status: 404 });
    const other = await f.intakeSvc.create(f.company.id, "owner", { ...f.input, requestKey: "other" });
    await expect(f.intakeSvc.preparationBaselineStatus(f.company.id, other.draft.id, f.baseline.id)).rejects.toMatchObject({ status: 404 });
    const outsider = onisallIntakeDraftService(db, storage, { type: "board", userId: "outsider", source: "session", companyIds: [f.company.id] });
    await expect(outsider.preparationBaselineStatus(f.company.id, f.draft.id, f.baseline.id)).rejects.toMatchObject({ status: 404 });
    const viewer = onisallIntakeDraftService(db, storage, { type: "board", userId: "owner", source: "session", companyIds: [f.company.id],
      memberships: [{ companyId: f.company.id, status: "active", membershipRole: "viewer" }] });
    expect((await viewer.preparationBaselineStatus(f.company.id, f.draft.id, f.baseline.id)).comparison.status).toBe("matches");
    await expect(viewer.createPreparationBaseline(f.company.id, f.draft.id, { requestKey: "viewer" })).rejects.toMatchObject({ status: 403 });
    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.company.id));
    await expect(f.intakeSvc.createPreparationBaseline(f.company.id, f.draft.id, { requestKey: "baseline" })).rejects.toMatchObject({ status: 409 });
  });
  it("rolls back a baseline when its audit cannot persist", async () => {
    const f = await setup(); await f.service.bind(f.company.id, f.draft.id, f.request);
    const failingDb = new Proxy(db, { get(target, key) {
      if (key === "transaction") return (work: (tx: unknown) => Promise<unknown>, options: Parameters<typeof db.transaction>[1]) =>
        db.transaction(async tx => work(new Proxy(tx, { get(conn, member) {
          if (member === "insert") return (table: unknown) => {
            if (table === activityLog) throw new Error("injected-baseline-audit-failure");
            return conn.insert(table as typeof activityLog);
          };
          const value = Reflect.get(conn, member); return typeof value === "function" ? value.bind(conn) : value;
        } })), options);
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(onisallIntakeDraftService(failingDb, storage, actor).createPreparationBaseline(f.company.id, f.draft.id, { requestKey: "audit" }))
      .rejects.toThrow("injected-baseline-audit-failure");
    expect(await db.select().from(onisallPreparationBaselines)).toHaveLength(0);
    expect((await f.intakeSvc.createPreparationBaseline(f.company.id, f.draft.id, { requestKey: "audit" })).replayed).toBe(false);
  });
  it.each(["case", "workflow"])("handles concurrent %s changes as a conflict or a historical observation", async change => {
    const f = await setup(); const { binding } = await f.service.bind(f.company.id, f.draft.id, f.request);
    let arrived!: () => void; let release!: () => void;
    const ready = new Promise<void>(r => { arrived = r; }); const hold = new Promise<void>(r => { release = r; });
    let reads = 0;
    beforeRead = async () => { if (++reads === 1) { arrived(); await hold; } };
    const inFlight = f.intakeSvc.createPreparationBaseline(f.company.id, f.draft.id, { requestKey: "concurrent" })
      .then(result => ({ result, error: null }), error => ({ result: null, error: error as unknown }));
    await ready;
    try {
      if (change === "case") await f.native.transitionCase({ companyId: f.company.id, caseId: binding.caseId,
        toStageKey: "in_progress", expectedVersion: 1, actor: { type: "user", userId: "owner" } });
      else await db.update(pipelineStages).set({ config: { autonomy: "manual" } })
        .where(and(eq(pipelineStages.pipelineId, f.pipeline.id), eq(pipelineStages.key, "in_progress")));
    } finally { release(); }
    const settled = await inFlight;
    beforeRead = undefined;
    if (change === "case") {
      // FK integrity checks can raise serialization failure after the native
      // row changes. The bounded fresh-snapshot retry must reject moved Cases.
      expect(reads).toBe(2); expect(settled.error).toMatchObject({ status: 409 });
      expect(await db.select().from(onisallPreparationBaselines)).toHaveLength(0);
      return;
    }
    expect(settled.error).toBeNull();
    const { baseline } = settled.result!;
    expect(baseline.caseVersion).toBe(1); expect(baseline.stageKey).toBe("intake");
    const status = await f.intakeSvc.preparationBaselineStatus(f.company.id, f.draft.id, baseline.id);
    expect(status.comparison.changes).toContain("workflow_changed");
  });
  it("revalidates real input and native current head with no effects or replayable authority", async () => {
    const f = await setup();
    expect((await f.intakeSvc.nativeRevalidation(f.company.id, f.draft.id)).native).toEqual({ status: "pending" });
    const { binding } = await f.service.bind(f.company.id, f.draft.id, f.request);
    const before = await Promise.all([pipelineCases, pipelineCaseEvents, onisallNativeBindings, activityLog,
      onisallInputObservations, pipelineAutomationExecutions, issues, heartbeatRuns].map(async table => await db.select().from(table)));
    const result = await f.intakeSvc.nativeRevalidation(f.company.id, f.draft.id);
    expect(result).toMatchObject({ protocol: "onisall.native-revalidation.v1", diagnosticsOnly: true,
      input: { status: "verified", snapshotId: binding.snapshotId },
      native: { status: "consistent", blockers: [], bindingId: binding.id, head: { version: 1, caseId: binding.caseId,
        stageKey: "intake", retired: false }, configuration: { status: "matches_binding", workflowBaseline: "not_frozen" } },
      publication: { status: "unavailable", executionAdmission: "not_granted" } });
    for (const key of ["fields", "leaseToken", "goal", "sourceLabel", "objectKey", "requestHash", "contentBase64"]) {
      expect(JSON.stringify(result)).not.toContain(`"${key}"`);
    }
    const after = await Promise.all([pipelineCases, pipelineCaseEvents, onisallNativeBindings, activityLog,
      onisallInputObservations, pipelineAutomationExecutions, issues, heartbeatRuns].map(async table => await db.select().from(table)));
    expect(after).toEqual(before);
    // Native edits can increment version without moving the Case. We observe
    // the real version, never synthesize one from binding revision=1.
    await db.update(pipelineCases).set({ version: 3 }).where(eq(pipelineCases.id, binding.caseId));
    expect((await f.intakeSvc.nativeRevalidation(f.company.id, f.draft.id)).native)
      .toMatchObject({ status: "consistent", head: { version: 3 } });
  });
  it.each(["move", "terminal", "retire", "archive", "disable", "automation", "ledger"])("blocks current native %s state", async change => {
    const f = await setup();
    const { binding } = await f.service.bind(f.company.id, f.draft.id, f.request);
    let reason: string;
    if (change === "move" || change === "terminal") {
      await f.native.transitionCase({ companyId: f.company.id, caseId: binding.caseId,
        toStageKey: change === "move" ? "in_progress" : "done", expectedVersion: 1, actor: { type: "user", userId: "owner" } });
      reason = change === "move" ? "case_left_entry_stage" : "case_terminal";
    } else if (change === "retire") {
      await db.update(pipelineCases).set({ retiredAt: new Date() }).where(eq(pipelineCases.id, binding.caseId));
      reason = "case_retired";
    } else if (change === "archive") {
      await db.update(pipelines).set({ archivedAt: new Date() }).where(eq(pipelines.id, f.pipeline.id));
      reason = "pipeline_archived";
    } else if (change === "ledger") {
      const [routine] = await db.insert(routines).values({ companyId: f.company.id, title: "Synthetic prior automation" }).returning();
      await db.insert(pipelineAutomationExecutions).values({ companyId: f.company.id, caseId: binding.caseId,
        automationId: "synthetic", triggeringEventId: randomUUID(), routineId: routine!.id, status: "failed" });
      reason = "automation_execution_exists";
    } else {
      await db.update(pipelineStages).set({ config: change === "disable" ? { disabled: true } : { onEnter: {} } })
        .where(and(eq(pipelineStages.pipelineId, f.pipeline.id), eq(pipelineStages.key, "intake")));
      reason = "entry_stage_unavailable";
    }
    const result = await f.intakeSvc.nativeRevalidation(f.company.id, f.draft.id);
    expect(result.native).toMatchObject({ status: "blocked", blockers: expect.arrayContaining([reason]) });
    expect(result.publication.executionAdmission).toBe("not_granted");
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
  });
  it.each(["archived", "paused", "completed", "cancelled"])("blocks a %s Project", async change => {
    const f = await setup(true);
    await f.service.bind(f.company.id, f.draft.id, f.request);
    await db.update(projects).set(change === "archived" ? { archivedAt: new Date() } : change === "paused"
      ? { pausedAt: new Date() } : { status: change }).where(eq(projects.id, f.project!.id));
    expect((await f.intakeSvc.nativeRevalidation(f.company.id, f.draft.id)).native).toMatchObject({ status: "blocked",
      blockers: expect.arrayContaining([change === "archived" ? "project_archived" : change === "paused" ? "project_paused" : "project_terminal"]) });
  });
  it.each(["marker", "caseKey", "version", "input", "request", "project"])("refuses inconsistent %s without returning native data", async change => {
    const f = await setup();
    const { binding } = await f.service.bind(f.company.id, f.draft.id, f.request);
    if (change === "marker") await db.update(pipelineCases).set({ fields: { onisall: { purpose: "preparation" } } }).where(eq(pipelineCases.id, binding.caseId));
    if (change === "caseKey") await db.update(pipelineCases).set({ caseKey: "different" }).where(eq(pipelineCases.id, binding.caseId));
    if (change === "version") await db.update(pipelineCases).set({ version: 0 }).where(eq(pipelineCases.id, binding.caseId));
    if (change === "input") await db.update(onisallNativeBindings).set({ inputSha256: "a".repeat(64) });
    if (change === "request") await db.update(onisallIntakeDrafts).set({ requestHash: "a".repeat(64) });
    if (change === "project") {
      const [project] = await db.insert(projects).values({ companyId: f.company.id, name: "Changed project" }).returning();
      await db.update(pipelines).set({ projectId: project!.id }).where(eq(pipelines.id, f.pipeline.id));
    }
    await expect(f.intakeSvc.nativeRevalidation(f.company.id, f.draft.id)).rejects.toMatchObject({ status: 409 });
  });
  it("enforces both recorded and current Project privacy, company scope and direct board", async () => {
    const f = await setup(true);
    await f.service.bind(f.company.id, f.draft.id, f.request);
    const outsider: AuthorizationActor = { type: "board", userId: "outsider", source: "session", companyIds: [f.company.id] };
    await expect(onisallIntakeDraftService(db, storage, outsider).nativeRevalidation(f.company.id, f.draft.id)).rejects.toMatchObject({ status: 404 });
    const [other] = await db.insert(companies).values({ name: "Foreign", issuePrefix: "FRG", status: "paused" }).returning();
    await expect(f.intakeSvc.nativeRevalidation(other!.id, f.draft.id)).rejects.toMatchObject({ status: 404 });
    const [hidden] = await db.insert(projects).values({ companyId: f.company.id, name: "Hidden", visibility: "private" }).returning();
    await db.update(pipelines).set({ projectId: hidden!.id }).where(eq(pipelines.id, f.pipeline.id));
    const member: AuthorizationActor = { type: "board", userId: "owner", source: "session", companyIds: [f.company.id] };
    await expect(onisallIntakeDraftService(db, storage, member).nativeRevalidation(f.company.id, f.draft.id)).rejects.toMatchObject({ status: 404 });
    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.company.id));
    await expect(f.intakeSvc.nativeRevalidation(f.company.id, f.draft.id)).rejects.toMatchObject({ status: 409 });
    await expect(onisallIntakeDraftService(db, storage).nativeRevalidation(f.company.id, f.draft.id)).rejects.toMatchObject({ status: 403 });
    await expect(onisallIntakeDraftService(db, storage, { ...actor, source: "mcp_oauth" }).nativeRevalidation(f.company.id, f.draft.id)).rejects.toMatchObject({ status: 403 });
  });
  it("detects entry/Pipeline changes and observes other Stage/Transition changes without claiming a frozen workflow", async () => {
    const f = await setup();
    await f.service.bind(f.company.id, f.draft.id, f.request);
    const read = async () => {
      const { native } = await f.intakeSvc.nativeRevalidation(f.company.id, f.draft.id);
      if (native.status === "pending") throw new Error("Expected native head");
      return native;
    };
    const baseline = await read();
    await db.update(pipelineStages).set({ config: { requireApproval: false } })
      .where(and(eq(pipelineStages.pipelineId, f.pipeline.id), eq(pipelineStages.key, "review")));
    const stageChanged = await read();
    expect(stageChanged.configuration.status).toBe("matches_binding");
    expect(stageChanged.configuration.workflowHash).not.toBe(baseline.configuration.workflowHash);
    expect(stageChanged.configuration.workflowBaseline).toBe("not_frozen");
    const stages = await db.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, f.pipeline.id));
    await db.insert(pipelineTransitions).values({ pipelineId: f.pipeline.id, fromStageId: stages[0]!.id, toStageId: stages[1]!.id, label: "Changed edge" })
      .onConflictDoUpdate({ target: [pipelineTransitions.pipelineId, pipelineTransitions.fromStageId, pipelineTransitions.toStageId], set: { label: "Changed edge" } });
    expect((await read()).configuration.workflowHash).not.toBe(stageChanged.configuration.workflowHash);
    await db.update(pipelines).set({ enforceTransitions: true }).where(eq(pipelines.id, f.pipeline.id));
    expect(await read()).toMatchObject({ status: "blocked", blockers: expect.arrayContaining(["preparation_configuration_changed"]) });
  });
  it("reports a removed entry Stage without inventing a configuration hash", async () => {
    const f = await setup();
    const { binding } = await f.service.bind(f.company.id, f.draft.id, f.request);
    await f.native.transitionCase({ companyId: f.company.id, caseId: binding.caseId,
      toStageKey: "in_progress", expectedVersion: 1, actor: { type: "user", userId: "owner" } });
    // Keep the immutable event history while emulating a missing entry key.
    await db.update(pipelineStages).set({ key: "renamed-entry" })
      .where(and(eq(pipelineStages.pipelineId, f.pipeline.id), eq(pipelineStages.key, "intake")));
    expect((await f.intakeSvc.nativeRevalidation(f.company.id, f.draft.id)).native).toMatchObject({ status: "blocked",
      blockers: expect.arrayContaining(["entry_stage_missing", "preparation_configuration_changed"]),
      configuration: { currentBindingHash: null, status: "changed" } });
  });
  it.each(["case", "entry", "input", "company", "binding", "project", "privacy"])("keeps one snapshot during concurrent %s commit, then rereads on the next request", async change => {
    const f = await setup(change === "project" || change === "privacy");
    const svc = onisallIntakeDraftService(db, storage, { type: "board", userId: "owner", source: "session", companyIds: [f.company.id] });
    const binding = change === "binding" ? null : (await f.service.bind(f.company.id, f.draft.id, f.request)).binding;
    let arrived!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { arrived = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    beforeRead = async () => { arrived(); await hold; };
    const inFlight = svc.nativeRevalidation(f.company.id, f.draft.id);
    await ready;
    beforeRead = undefined;
    try {
      if (change === "case") await f.native.transitionCase({ companyId: f.company.id, caseId: binding!.caseId,
        toStageKey: "in_progress", expectedVersion: 1, actor: { type: "user", userId: "owner" } });
      if (change === "entry") await db.update(pipelineStages).set({ config: { disabled: true } })
        .where(and(eq(pipelineStages.pipelineId, f.pipeline.id), eq(pipelineStages.key, "intake")));
      if (change === "input") await db.update(onisallInputSnapshots).set({ lineCount: 999 });
      if (change === "company") await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.company.id));
      if (change === "binding") await f.service.bind(f.company.id, f.draft.id, f.request);
      if (change === "project") await db.update(projects).set({ pausedAt: new Date() }).where(eq(projects.id, f.project!.id));
      if (change === "privacy") await db.delete(projectAccessMembers).where(eq(projectAccessMembers.projectId, f.project!.id));
    } finally { release(); }
    expect((await inFlight).native).toMatchObject(change === "binding" ? { status: "pending" }
      : { status: "consistent", head: { version: 1, stageKey: "intake" } });
    if (change === "input" || change === "company" || change === "privacy") {
      await expect(svc.nativeRevalidation(f.company.id, f.draft.id)).rejects.toMatchObject({ status: change === "privacy" ? 404 : 409 });
    } else {
      expect((await svc.nativeRevalidation(f.company.id, f.draft.id)).native).toMatchObject(change === "binding"
        ? { status: "consistent" } : { status: "blocked" });
    }
  });
  it("atomically binds the draft and native Case, preserving the input and no execution authority", async () => {
    const f = await setup();
    const first = await f.service.bind(f.company.id, f.draft.id, f.request);
    const replay = await f.service.bind(f.company.id, f.draft.id, f.request);
    expect(first.replayed).toBe(false); expect(replay.replayed).toBe(true);
    expect(replay.binding.id).toBe(first.binding.id);
    const draft = await f.intakeSvc.get(f.company.id, f.draft.id);
    expect(draft).toMatchObject({ draftVersion: 2, status: "draft", bindingStatus: "bound", caseId: first.binding.caseId,
      contractId: null, binding: { revision: 1, executionAdmission: "not_granted", purpose: "preparation" } });
    expect((await f.intakeSvc.create(f.company.id, "owner", f.input)).draft.caseId).toBe(first.binding.caseId);
    expect(await db.select().from(pipelineCases)).toHaveLength(1);
    expect(await db.select().from(pipelineCaseEvents)).toHaveLength(1);
    expect(await db.select().from(onisallInputObservations)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "onisall.intake.bound"))).toHaveLength(1);
    expect(await db.select().from(pipelineAutomationExecutions)).toHaveLength(0);
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
  });
  it("reads pending and bound preparation status without any persistent effects", async () => {
    const f = await setup();
    const pending = await f.intakeSvc.preparationStatus(f.company.id, f.draft.id);
    expect(pending.nativeBinding).toEqual({ status: "pending" });
    expect(pending.input.sha256).toBe(f.draft.initialSnapshot.sha256);
    expect(await db.select().from(pipelineCases)).toHaveLength(0);
    const { binding } = await f.service.bind(f.company.id, f.draft.id, f.request);
    async function counts() {
      return Promise.all([activityLog, pipelineCases, pipelineCaseEvents, onisallInputObservations,
        pipelineAutomationExecutions, issues, heartbeatRuns].map(async table => (await db.select().from(table)).length));
    }
    const before = await counts();
    const result = await f.intakeSvc.preparationStatus(f.company.id, f.draft.id);
    expect(result.nativeBinding).toEqual({ status: "recorded", bindingId: binding.id, caseId: binding.caseId, revision: 1 });
    expect(result.publication.executionAdmission).toBe("not_granted");
    expect(await counts()).toEqual(before);
    // Presence stays a recorded fact even if native state later moves. The
    // current-head prerequisite must remain explicitly unevaluated.
    await f.native.transitionCase({ companyId: f.company.id, caseId: binding.caseId,
      toStageKey: "in_progress", expectedVersion: 1, actor: { type: "user", userId: "owner" } });
    const moved = await f.intakeSvc.preparationStatus(f.company.id, f.draft.id);
    expect(moved.remainingChecks).toContainEqual({ code: "native_current_head", status: "not_evaluated" });
    expect(moved.publication.executionAdmission).toBe("not_granted");
  });
  it("fails the diagnostic on changed stored bytes or database metadata", async () => {
    const f = await setup();
    const [snapshot] = await db.select().from(onisallInputSnapshots);
    const original = blobs.get(snapshot!.objectKey)!;
    blobs.set(snapshot!.objectKey, Buffer.from("corrupted"));
    await expect(f.intakeSvc.preparationStatus(f.company.id, f.draft.id)).rejects.toMatchObject({ status: 409 });
    blobs.set(snapshot!.objectKey, original);
    await db.update(onisallInputSnapshots).set({ lineCount: 900 }).where(eq(onisallInputSnapshots.id, snapshot!.id));
    await expect(f.intakeSvc.preparationStatus(f.company.id, f.draft.id)).rejects.toMatchObject({ status: 409 });
    await db.update(onisallInputSnapshots).set({ lineCount: 2 }).where(eq(onisallInputSnapshots.id, snapshot!.id));
    await f.service.bind(f.company.id, f.draft.id, f.request);
    await db.update(onisallNativeBindings).set({ inputSha256: "a".repeat(64) });
    await expect(f.intakeSvc.preparationStatus(f.company.id, f.draft.id)).rejects.toMatchObject({ status: 409 });
  });
  it("keeps status scoped to the company and private Project and rejects inactive companies", async () => {
    const f = await setup(true);
    await expect(f.intakeSvc.preparationStatus(randomUUID(), f.draft.id)).rejects.toMatchObject({ status: 404 });
    const [paused] = await db.insert(companies).values({ name: "Paused foreign company", issuePrefix: "PAU", status: "paused" }).returning();
    await expect(f.intakeSvc.preparationStatus(paused!.id, f.draft.id)).rejects.toMatchObject({ status: 404 });
    await f.service.bind(f.company.id, f.draft.id, f.request);
    const outsider: AuthorizationActor = { type: "board", userId: "outsider", source: "session", companyIds: [f.company.id] };
    await expect(onisallIntakeDraftService(db, storage, outsider).preparationStatus(f.company.id, f.draft.id))
      .rejects.toMatchObject({ status: 404 });
    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.company.id));
    await expect(f.intakeSvc.preparationStatus(f.company.id, f.draft.id)).rejects.toMatchObject({ status: 409 });
  });
  it("serializes simultaneous binding requests to one Case and binding", async () => {
    const f = await setup();
    const results = await Promise.all(Array.from({ length: 4 }, () => f.service.bind(f.company.id, f.draft.id, f.request)));
    expect(results.filter(row => !row.replayed)).toHaveLength(1);
    expect(new Set(results.map(row => row.binding.caseId)).size).toBe(1);
    expect(await db.select().from(onisallNativeBindings)).toHaveLength(1);
    expect(await db.select().from(pipelineCaseEvents)).toHaveLength(1);
  });
  it("rejects stale input, changed configuration, and conflicting targets without orphan Cases", async () => {
    const f = await setup();
    await expect(f.service.bind(f.company.id, f.draft.id, { ...f.request, inputSha256: "0".repeat(64) })).rejects.toMatchObject({ status: 409 });
    await db.update(pipelineStages).set({ config: { autonomy: "manual" } })
      .where(and(eq(pipelineStages.pipelineId, f.pipeline.id), eq(pipelineStages.key, "intake")));
    await expect(f.service.bind(f.company.id, f.draft.id, f.request)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(pipelineCases)).toHaveLength(0);
    const fresh = request(await f.service.context(f.company.id, f.draft.id, { pipelineId: f.pipeline.id, entryStageKey: "intake" }));
    await f.service.bind(f.company.id, f.draft.id, fresh);
    const other = await f.native.createPipeline({ companyId: f.company.id, key: "other", name: "Other", actor: { type: "user", userId: "owner" } });
    const changed = request(await f.service.context(f.company.id, f.draft.id, { pipelineId: other.id, entryStageKey: "intake" }));
    await expect(f.service.bind(f.company.id, f.draft.id, changed)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(pipelineCases)).toHaveLength(1);
  });
  it("enforces company and Project scope and private project reads", async () => {
    const f = await setup(true);
    await expect(f.service.bind(f.company.id, f.draft.id, { ...f.request, projectId: null })).rejects.toMatchObject({ status: 409 });
    await expect(f.service.context(randomUUID(), f.draft.id, { pipelineId: f.pipeline.id, entryStageKey: "intake" })).rejects.toMatchObject({ status: 404 });
    await f.service.bind(f.company.id, f.draft.id, f.request);
    const outsider: AuthorizationActor = { type: "board", userId: "outsider", source: "session", companyIds: [f.company.id] };
    await expect(onisallNativeBindingService(db, storage, outsider).get(f.company.id, f.draft.id)).rejects.toMatchObject({ status: 404 });
    await expect(onisallIntakeDraftService(db, storage, outsider).content(f.company.id, f.draft.id)).rejects.toMatchObject({ status: 404 });
  });
  it("keeps company/snapshot/Case/Project references consistent in the database", async () => {
    const f = await setup(true);
    const { binding } = await f.service.bind(f.company.id, f.draft.id, f.request);
    const [other] = await db.insert(companies).values({ name: "Other", issuePrefix: "OTH", defaultResponsibleUserId: "owner" }).returning();
    const [foreignProject] = await db.insert(projects).values({ companyId: other!.id, name: "Foreign" }).returning();
    await expect(db.update(onisallNativeBindings).set({ companyId: other!.id }).where(eq(onisallNativeBindings.id, binding.id))).rejects.toBeDefined();
    await expect(db.update(onisallNativeBindings).set({ projectId: foreignProject!.id }).where(eq(onisallNativeBindings.id, binding.id))).rejects.toBeDefined();
    await expect(db.update(onisallNativeBindings).set({ snapshotId: randomUUID() }).where(eq(onisallNativeBindings.id, binding.id))).rejects.toBeDefined();
    await expect(db.update(onisallNativeBindings).set({ executionAdmission: "granted" }).where(eq(onisallNativeBindings.id, binding.id))).rejects.toBeDefined();
  });
  it("rejects archived or automated entry and does not adopt an existing native Case", async () => {
    const f = await setup();
    await f.native.ingestCase({ companyId: f.company.id, pipelineId: f.pipeline.id,
      caseKey: `onisall.intake:${f.draft.id}`, title: "Preexisting untrusted Case", actor: { type: "user", userId: "owner" } });
    await expect(f.service.bind(f.company.id, f.draft.id, f.request)).rejects.toMatchObject({ status: 409 });
    await db.update(pipelines).set({ archivedAt: new Date() }).where(eq(pipelines.id, f.pipeline.id));
    await expect(f.service.bind(f.company.id, f.draft.id, f.request)).rejects.toMatchObject({ status: 409 });
    await db.update(pipelines).set({ archivedAt: null }).where(eq(pipelines.id, f.pipeline.id));
    await db.update(pipelineStages).set({ config: { onEnter: { type: "run_routine", routineId: randomUUID() } } })
      .where(and(eq(pipelineStages.pipelineId, f.pipeline.id), eq(pipelineStages.key, "intake")));
    await expect(f.service.context(f.company.id, f.draft.id, { pipelineId: f.pipeline.id, entryStageKey: "intake" })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(onisallNativeBindings)).toHaveLength(0);
  });
  it("blocks automatic stage entry even after native configuration is changed", async () => {
    const f = await setup();
    const { binding } = await f.service.bind(f.company.id, f.draft.id, f.request);
    const [routine] = await db.insert(routines).values({ companyId: f.company.id, title: "Must not run", status: "paused" }).returning();
    await db.update(pipelineStages).set({ config: { onEnter: { type: "run_routine", routineId: routine!.id } } })
      .where(and(eq(pipelineStages.pipelineId, f.pipeline.id), eq(pipelineStages.key, "in_progress")));
    await expect(f.native.transitionCase({ companyId: f.company.id, caseId: binding.caseId,
      toStageKey: "in_progress", expectedVersion: 1, actor: { type: "user", userId: "owner" } }))
      .rejects.toMatchObject({ status: 409, details: { code: "onisall_execution_not_granted" } });
    expect((await db.select().from(pipelineCases))[0]!.version).toBe(1);
    expect(await db.select().from(pipelineAutomationExecutions)).toHaveLength(0);
    expect(await db.select().from(routineRuns)).toHaveLength(0);
    // A pending legacy ledger must not bypass preparation admission either.
    const [event] = await db.select().from(pipelineCaseEvents).where(eq(pipelineCaseEvents.caseId, binding.caseId));
    await db.insert(pipelineAutomationExecutions).values({ companyId: f.company.id, caseId: binding.caseId,
      automationId: "injected-pending", triggeringEventId: event!.id, routineId: routine!.id,
      status: "failed", error: "pending_dispatch" });
    await expect(f.native.retryAutomation({ companyId: f.company.id, caseId: binding.caseId,
      automationId: "injected-pending", actor: { type: "user", userId: "owner" } }))
      .rejects.toMatchObject({ status: 409, details: { code: "onisall_execution_not_granted" } });
    expect(await db.select().from(routineRuns)).toHaveLength(0);
  });
  it("rolls back Case, binding and draft projection after an audit failure", async () => {
    const f = await setup();
    const failingDb = new Proxy(db, { get(target, key) {
      if (key === "transaction") return (work: (tx: unknown) => Promise<unknown>) => db.transaction(async tx => {
        const failingTx = new Proxy(tx, { get(conn, member) {
          if (member === "insert") return (table: unknown) => {
            if (table === activityLog) throw new Error("injected-audit-failure");
            return conn.insert(table as typeof activityLog);
          };
          const value = Reflect.get(conn, member); return typeof value === "function" ? value.bind(conn) : value;
        } });
        return work(failingTx);
      });
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(onisallNativeBindingService(failingDb, storage, actor).bind(f.company.id, f.draft.id, f.request))
      .rejects.toThrow("injected-audit-failure");
    expect(await db.select().from(onisallNativeBindings)).toHaveLength(0);
    expect(await db.select().from(pipelineCases)).toHaveLength(0);
    expect(await db.select().from(pipelineCaseEvents)).toHaveLength(0);
    expect(await db.select().from(documents)).toHaveLength(0);
    expect((await f.intakeSvc.get(f.company.id, f.draft.id)).bindingStatus).toBe("binding_pending");
    expect((await f.service.bind(f.company.id, f.draft.id, f.request)).replayed).toBe(false);
  });
  it.each(["archive", "entry", "project"])("waits on concurrent %s change then rejects without a binding", async change => {
    const f = await setup();
    const [project] = await db.insert(projects).values({ companyId: f.company.id, name: "Changed scope" }).returning();
    let release!: () => void;
    let locked!: () => void;
    let blockerPid = 0;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const writer = db.transaction(async tx => {
      await tx.execute(sql`set local idle_in_transaction_session_timeout = '15s'`);
      const [pid] = await tx.execute(sql`select pg_backend_pid() as pid`);
      blockerPid = Number(pid!.pid);
      if (change === "archive") await tx.update(pipelines).set({ archivedAt: new Date() }).where(eq(pipelines.id, f.pipeline.id));
      if (change === "project") await tx.update(pipelines).set({ projectId: project!.id }).where(eq(pipelines.id, f.pipeline.id));
      if (change === "entry") await tx.update(pipelineStages).set({ config: { autonomy: "manual" } })
        .where(and(eq(pipelineStages.pipelineId, f.pipeline.id), eq(pipelineStages.key, "intake")));
      locked(); await hold;
    });
    await ready;
    const rejected = expect(f.service.bind(f.company.id, f.draft.id, f.request)).rejects.toMatchObject({ status: 409 });
    let observedWait = false;
    try {
      for (let i = 0; i < 100; i++) {
        const [row] = await db.execute(sql`select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and ${blockerPid} = any(pg_blocking_pids(pid))`);
        if (Number(row!.waiting) > 0) { observedWait = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally { release(); }
    await writer; await rejected;
    expect(observedWait).toBe(true);
    expect(await db.select().from(onisallNativeBindings)).toHaveLength(0);
    expect(await db.select().from(pipelineCases)).toHaveLength(0);
  });
});
