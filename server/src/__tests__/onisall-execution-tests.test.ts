import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, createDb, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { ONISALL_EXECUTION_TEST_BUNDLE, ONISALL_EXECUTION_TEST_MARKER, ONISALL_EXECUTION_TEST_MODEL,
  ONISALL_EXECUTION_TEST_PROMPT, ONISALL_EXECUTION_TEST_REASON } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { admitExecutionTest, assertExecutionTestDispatch, assertExecutionTestRequest } from "../services/onisall/execution-test-policy.js";
import { evaluateExecutionTest, onisallExecutionTestService } from "../services/onisall/execution-tests.js";
import type { AuthorizationActor } from "../services/authorization.js";
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
const actor: AuthorizationActor = { type: "board", source: "local_implicit", userId: "owner" };
const config = { qualificationMode: true, model: ONISALL_EXECUTION_TEST_MODEL, promptTemplate: ONISALL_EXECUTION_TEST_PROMPT,
  maxTurns: 1, timeoutSec: 120, effort: "low", authMode: "commandcode", spendAuthorizationRef: "docs/work/tasks/ONS-0024-preparation-browsing.md" };
const options = { manualUserWake: true, requestedByActorType: "user", requestedByActorId: "owner", reason: ONISALL_EXECUTION_TEST_REASON,
  contextSnapshot: { onisallDirectBoard: true, onisallBoardSource: "local_implicit", actorId: "owner", forceFreshSession: true } };
(support.supported ? describe : describe.skip)("development execution checks with real temporary PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { fixture = await startEmbeddedPostgresTestDatabase("onisall-execution-tests-"); db = createDb(fixture.connectionString); }, 30000);
  afterAll(async () => { await fixture?.cleanup(); });
  async function setup() {
    const [company] = await db.insert(companies).values({ name: "Execution fixture", issuePrefix: `E${randomUUID().slice(0, 7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Probe", adapterType: "commandcode_local", adapterConfig: config,
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } }).returning();
    const slots = await db.insert(issues).values([1, 2, 3, 4].map(n => ({ companyId: company!.id, title: `Slot ${n}`, status: "todo", assigneeAgentId: agent!.id }))).returning();
    const [profile] = await db.update(agents).set({ metadata: { onisallExecutionTest: { version: 1, task: "ONS-0024", issueIds: slots.map(issue => issue.id) } } }).where(eq(agents.id, agent!.id)).returning();
    return { company: company!, agent: profile!, slots };
  }
  async function completed(f: Awaited<ReturnType<typeof setup>>, index = 0, patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const id = randomUUID();
    const [run] = await db.insert(heartbeatRuns).values({ id, companyId: f.company.id, agentId: f.agent.id, issueId: f.slots[index]!.id,
      scopeKind: "issue", status: "succeeded", exitCode: 0, contextSnapshot: options.contextSnapshot,
      resultJson: { schema: "onisall.commandcode.execution.v1", companyId: f.company.id, agentId: f.agent.id, issueId: f.slots[index]!.id, runId: id,
        cliVersion: "1.79.2", bundleSha256: ONISALL_EXECUTION_TEST_BUNDLE, requestedModel: ONISALL_EXECUTION_TEST_MODEL,
        summary: ONISALL_EXECUTION_TEST_MARKER, localProcess: { exitObserved: true, closeObserved: true } }, ...patch }).returning();
    return run!;
  }
  it("allows a fresh manual request and rejects automatic, delegated and unbound requests", async () => {
    const f = await setup(), issueId = f.slots[0]!.id;
    expect(() => assertExecutionTestRequest(f.agent, issueId, options)).not.toThrow();
    for (const patch of [{ manualUserWake: false }, { requestedByActorType: "agent" }, { contextSnapshot: { onisallDirectBoard: false, forceFreshSession: true } }, { reason: "timer" }]) {
      expect(() => assertExecutionTestRequest(f.agent, issueId, { ...options, ...patch })).toThrow();
    }
    expect(() => assertExecutionTestRequest(f.agent, randomUUID(), options)).toThrow();
    expect(() => assertExecutionTestRequest(f.agent, null, options)).toThrow();
  });
  it("two simultaneous admissions of one slot create exactly one Run, including terminal failures", async () => {
    const f = await setup(), issueId = f.slots[0]!.id;
    const admission = () => db.transaction(async tx => {
      await tx.execute(sql`select id from issues where id = ${issueId} for update`);
      await admitExecutionTest(tx, f.agent, issueId, options);
      await tx.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, issueId, scopeKind: "issue", status: "failed" });
    });
    const result = await Promise.allSettled([admission(), admission()]);
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id))).toHaveLength(1);
    await expect(admission()).rejects.toMatchObject({ status: 409 });
  });
  it("suppresses native automatic completion repair without throwing or creating another Run", async () => {
    const f = await setup();
    await expect(heartbeatService(db).wakeup(f.agent.id, { source: "automation", requestedByActorType: "system",
      reason: "disposition_repair", payload: { issueId: f.slots[0]!.id } })).resolves.toBeNull();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id))).toHaveLength(0);
  });
  it("serializes different slots against the total four-Run allowance", async () => {
    const f = await setup();
    for (let i = 0; i < 3; i++) await completed(f, i);
    await db.update(heartbeatRuns).set({ issueId: null }).where(eq(heartbeatRuns.agentId, f.agent.id));
    const request = (id: string) => db.transaction(async tx => {
      await tx.execute(sql`select id from issues where id = ${id} for update`);
      await admitExecutionTest(tx, f.agent, id, options);
      await tx.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, issueId: id, scopeKind: "issue", status: "failed" });
    });
    const result = await Promise.allSettled([request(f.slots[0]!.id), request(f.slots[1]!.id)]);
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id))).toHaveLength(4);
  });
  it("checks current company, task assignment, hidden tasks and changed configuration under the lock", async () => {
    const f = await setup(), id = f.slots[0]!.id;
    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.company.id));
    await expect(db.transaction(tx => admitExecutionTest(tx, f.agent, id, options))).rejects.toMatchObject({ status: 409 });
    await db.update(companies).set({ status: "active" }).where(eq(companies.id, f.company.id));
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, id));
    await expect(db.transaction(tx => admitExecutionTest(tx, f.agent, id, options))).rejects.toMatchObject({ status: 409 });
    await db.update(issues).set({ hiddenAt: null, assigneeAgentId: null }).where(eq(issues.id, id));
    await expect(db.transaction(tx => admitExecutionTest(tx, f.agent, id, options))).rejects.toMatchObject({ status: 409 });
    await db.update(issues).set({ assigneeAgentId: f.agent.id }).where(eq(issues.id, id));
    await db.update(issues).set({ visibility: "private", privacyRootIssueId: id }).where(eq(issues.id, id));
    await expect(db.transaction(tx => admitExecutionTest(tx, f.agent, id, options))).rejects.toMatchObject({ status: 409 });
    await db.update(issues).set({ visibility: "open", privacyRootIssueId: null }).where(eq(issues.id, id));
    await db.update(agents).set({ adapterConfig: { ...config, promptTemplate: "changed" } }).where(eq(agents.id, f.agent.id));
    await expect(db.transaction(tx => admitExecutionTest(tx, f.agent, id, options))).rejects.toMatchObject({ status: 409 });
  });
  it("serializes allowance across slots and blocks a fifth Run or a queued company Run", async () => {
    const f = await setup();
    for (let i = 0; i < 4; i++) await completed(f, i);
    await db.update(heartbeatRuns).set({ issueId: null }).where(eq(heartbeatRuns.agentId, f.agent.id));
    await expect(db.transaction(tx => admitExecutionTest(tx, f.agent, f.slots[0]!.id, options))).rejects.toThrow("allowance exhausted");
    const fresh = await setup(); await completed(fresh, 0, { status: "queued" });
    await expect(db.transaction(tx => admitExecutionTest(tx, fresh.agent, fresh.slots[1]!.id, options))).rejects.toThrow("company Runs");
  });
  it("rechecks effective configuration before adapter dispatch", async () => {
    const f = await setup(), run = await completed(f, 0, { status: "running" });
    await expect(assertExecutionTestDispatch(db, f.agent, run, config)).resolves.toBeUndefined();
    await expect(assertExecutionTestDispatch(db, f.agent, run, config)).rejects.toThrow("already reserved");
    await expect(assertExecutionTestDispatch(db, f.agent, run, { ...config, maxTurns: 2 })).rejects.toMatchObject({ status: 409 });
    await db.update(agents).set({ metadata: null }).where(eq(agents.id, f.agent.id));
    await expect(assertExecutionTestDispatch(db, f.agent, run, config)).rejects.toMatchObject({ status: 409 });
  });
  it("allows one adapter entry under concurrent recovery for the same native Run", async () => {
    const f = await setup(), run = await completed(f, 0, { status: "running" });
    const result = await Promise.allSettled([assertExecutionTestDispatch(db, f.agent, run, config), assertExecutionTestDispatch(db, f.agent, run, config)]);
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const [current] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    expect(Object.keys(current!.metadata!.onisallExecutionTestDispatches as object)).toEqual([run.id]);
  });
  it("derives exact protocol success without claiming business acceptance or free cost", async () => {
    const f = await setup(), run = await completed(f), checked = evaluateExecutionTest(run);
    expect(checked.verdict).toBe("pass"); expect(checked.outputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(checked).toMatchObject({ costStatus: "unpriced", inputTokens: null, businessAcceptance: "not_evaluated", providerStop: "unknown", actualModel: null, executionGrant: "not_granted" });
    for (const result of [{ ...run.resultJson, summary: ONISALL_EXECUTION_TEST_MARKER + "\n" }, { ...run.resultJson, issueId: randomUUID() }, { ...run.resultJson, bundleSha256: "changed" }]) {
      expect(evaluateExecutionTest({ ...run, resultJson: result }).verdict).toBe("fail");
    }
    expect(evaluateExecutionTest({ ...run, status: "running" }).verdict).toBe("pending");
    expect(evaluateExecutionTest({ ...run, status: "scheduled_retry" }).verdict).toBe("pending");
    expect(evaluateExecutionTest({ ...run, status: "cancelled" }).verdict).toBe("fail");
  });
  it("reads current membership rather than trusting a stale actor company list", async () => {
    const f = await setup();
    await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: "member", membershipRole: "viewer" });
    const viewer: AuthorizationActor = { type: "board", source: "session", userId: "member", companyIds: [f.company.id] };
    expect((await onisallExecutionTestService(db, viewer).list(f.company.id)).slots).toHaveLength(4);
    await db.update(companyMemberships).set({ status: "inactive" }).where(and(eq(companyMemberships.companyId, f.company.id), eq(companyMemberships.principalId, "member")));
    await expect(onisallExecutionTestService(db, viewer).list(f.company.id)).rejects.toMatchObject({ status: 403 });
    const revokedOptions = { ...options, requestedByActorId: "member", contextSnapshot: { ...options.contextSnapshot, onisallBoardSource: "session", actorId: "member" } };
    await expect(db.transaction(tx => admitExecutionTest(tx, f.agent, f.slots[0]!.id, revokedOptions))).rejects.toMatchObject({ status: 403 });
  });
  it("hides private Project outputs, cross-company Runs and removed tasks", async () => {
    const f = await setup(), other = await setup(), run = await completed(f);
    await expect(onisallExecutionTestService(db, actor).evaluate(other.company.id, run.id)).rejects.toMatchObject({ status: 404 });
    const [project] = await db.insert(projects).values({ companyId: f.company.id, name: "Private", visibility: "private", privacyOwnerUserId: "other" }).returning();
    await db.update(issues).set({ projectId: project!.id }).where(eq(issues.id, run.issueId!));
    expect((await onisallExecutionTestService(db, actor).list(f.company.id)).slots).toHaveLength(3);
    await expect(onisallExecutionTestService(db, actor).evaluate(f.company.id, run.id)).rejects.toMatchObject({ status: 404 });
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, f.slots[1]!.id));
    expect((await onisallExecutionTestService(db, actor).list(f.company.id)).slots).toHaveLength(2);
  });
});
