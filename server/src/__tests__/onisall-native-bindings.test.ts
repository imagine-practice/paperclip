import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, companies, projects, projectAccessMembers, pipelines, pipelineStages, pipelineCases, pipelineCaseEvents,
  pipelineAutomationExecutions, documents, activityLog, issues, routines, routineRuns, heartbeatRuns,
  onisallIntakeDrafts, onisallInputObservations, onisallInputSnapshots, onisallNativeBindings } from "@paperclipai/db";
import type { CreateOnisallBinding, OnisallBindingContext } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { onisallNativeBindingService } from "../services/onisall/native-bindings.js";
import { onisallIntakeDraftService } from "../services/onisall/intake-drafts.js";
import { pipelineService } from "../services/pipelines.js";
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
  const storage: StorageService = {
    provider: "local_disk",
    async putFile(input) {
      if (!Buffer.isBuffer(input.body)) throw new Error("Expected buffer fixture");
      blobs.set(input.objectKey!, Buffer.from(input.body));
      return { provider: "local_disk", objectKey: input.objectKey!, byteSize: input.body.length,
        sha256: createHash("sha256").update(input.body).digest("hex"), contentType: input.contentType,
        originalFilename: input.originalFilename };
    },
    async getObject(_company, key) { return { stream: Readable.from([blobs.get(key)!]) }; },
    async headObject() { throw new Error("Not used"); },
    async deleteObject() { throw new Error("Unexpected deletion"); },
  };
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("paperclip-onisall-binding-");
    db = createDb(fixture.connectionString);
  }, 30_000);
  afterEach(async () => {
    // Dedicated test database only, never the development instance.
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
