import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { agents, companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { ONISALL_EXECUTION_TEST_BUNDLE, ONISALL_EXECUTION_TEST_MARKER, ONISALL_EXECUTION_TEST_MODEL,
  ONISALL_EXECUTION_TEST_PROMPT, type OnisallExecutionTestEvaluation, type OnisallExecutionTests } from "@paperclipai/shared";
import { forbidden, notFound } from "../../errors.js";
import { accessService } from "../access.js";
import type { AuthorizationActor } from "../authorization.js";
import { assertBindingProjectVisible } from "./binding-view.js";
import { executionTestConfigurationMatches, executionTestPolicy } from "./execution-test-policy.js";

type Run = typeof heartbeatRuns.$inferSelect;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
export const executionTestRunView = (run: Run) => ({ id: run.id, status: run.status,
  startedAt: run.startedAt?.toISOString() ?? null, finishedAt: run.finishedAt?.toISOString() ?? null });
/** Derives a diagnostic from persisted native output; never accepts a client verdict. */
export function evaluateExecutionTest(run: Run, now = new Date()): OnisallExecutionTestEvaluation {
  const result = record(run.resultJson), process = record(result.localProcess), usage = record(run.usageJson);
  const output = typeof result.summary === "string" ? result.summary.slice(0, 16000) : null;
  const pending = ["queued", "running", "scheduled_retry"].includes(run.status);
  const predicates: [string, boolean][] = [
    ["native_run_succeeded", run.status === "succeeded" && run.exitCode === 0 && !run.errorCode],
    ["execution_protocol", result.schema === "onisall.commandcode.execution.v1"],
    ["native_scope", run.scopeKind === "issue" && result.companyId === run.companyId && result.agentId === run.agentId && result.issueId === run.issueId && result.runId === run.id],
    ["pinned_cli", result.cliVersion === "1.79.2" && result.bundleSha256 === ONISALL_EXECUTION_TEST_BUNDLE],
    ["requested_model", result.requestedModel === ONISALL_EXECUTION_TEST_MODEL],
    ["exact_output", output === ONISALL_EXECUTION_TEST_MARKER],
    ["local_process_exit", process.exitObserved === true && process.closeObserved === true],
  ];
  const checks = predicates.map(([code, pass]) => ({ code, status: pending ? "pending" as const : pass ? "pass" as const : "fail" as const }));
  return { protocol: "onisall.execution-test-evaluation.v1", companyId: run.companyId, agentId: run.agentId,
    issueId: run.issueId!, run: executionTestRunView(run), evaluatedAt: now.toISOString(), output,
    outputSha256: output === null ? null : createHash("sha256").update(output, "utf8").digest("hex"), checks,
    verdict: pending ? "pending" : checks.every(check => check.status === "pass") ? "pass" : "fail",
    requestedModel: typeof result.requestedModel === "string" ? result.requestedModel : null,
    cliReportedModels: Array.isArray(result.cliReportedModels) ? result.cliReportedModels.filter((v): v is string => typeof v === "string").slice(0, 16) : [],
    actualModel: null, inputTokens: number(usage.inputTokens), outputTokens: number(usage.outputTokens),
    costStatus: "unpriced", usageComplete: false, providerStop: "unknown", businessAcceptance: "not_evaluated",
    independentReview: "not_configured", executionGrant: "not_granted" };
}
export function onisallExecutionTestService(db: Db, actor: AuthorizationActor) {
  async function visibleIssue(conn: Db, companyId: string, issueId: string) {
    const [issue] = await conn.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
    if (!issue || issue.hiddenAt) return null;
    const permission = await accessService(conn).decide({ actor, action: "issue:read", resource: {
      type: "issue", companyId, issueId, projectId: issue.projectId, parentIssueId: issue.parentId,
      assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId } });
    if (!permission.allowed) return null;
    if (issue.projectId) {
      try { await assertBindingProjectVisible(conn, companyId, issue.projectId, actor); }
      catch (error) { if (error instanceof Error && "status" in error && error.status === 404) return null; throw error; }
    }
    return issue;
  }
  async function scope(conn: Db, companyId: string) {
    if (actor.type !== "board" || !actor.userId || actor.source === "mcp_oauth") throw forbidden("Direct board session required");
    const access = await accessService(conn).decide({ actor, action: "company_scope:read", resource: { type: "company", companyId } });
    if (!access.allowed) throw forbidden("Company access required");
    const [company] = await conn.select().from(companies).where(eq(companies.id, companyId));
    if (!company) throw notFound("Company not found");
    return company;
  }
  return {
    async list(companyId: string): Promise<OnisallExecutionTests> {
      return db.transaction(async tx => {
        const conn = tx as unknown as Db, company = await scope(conn, companyId);
        const profiles = await conn.select().from(agents).where(and(eq(agents.companyId, companyId), sql`${agents.metadata} ? 'onisallExecutionTest'`)).limit(100);
        const activeRuns = await conn.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]))).limit(1);
        const slots: OnisallExecutionTests["slots"] = [];
        for (const agent of profiles) {
          // Malformed profiles are unavailable rather than falling back to unrestricted execution.
          let policy; try { policy = executionTestPolicy(agent); } catch { continue; }
          if (!policy) continue;
          const runs = await conn.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agent.id))).orderBy(desc(heartbeatRuns.createdAt));
          for (const issueId of policy.issueIds) {
            const issue = await visibleIssue(conn, companyId, issueId); if (!issue) continue;
            const run = runs.find(row => row.issueId === issueId);
            const blockers: string[] = [];
            if (company.status !== "active") blockers.push("company_inactive");
            if (activeRuns.length) blockers.push("company_runs_active");
            if (agent.status !== "idle") blockers.push("agent_unavailable");
            if (!executionTestConfigurationMatches(agent)) blockers.push("configuration_changed");
            if (issue.projectId || issue.parentId || issue.visibility !== "open" || issue.assigneeAgentId !== agent.id || !["todo", "in_progress"].includes(issue.status)) blockers.push("slot_changed");
            if (run) blockers.push("single_use_dispatched");
            if (runs.length >= 4) blockers.push("allowance_exhausted");
            slots.push({ agentId: agent.id, issueId, identifier: issue.identifier ?? issue.id, title: issue.title,
              available: blockers.length === 0, blockers, run: run ? executionTestRunView(run) : null });
          }
        }
        return { protocol: "onisall.execution-tests.v1", companyId, evaluatedAt: new Date().toISOString(), model: ONISALL_EXECUTION_TEST_MODEL,
          prompt: ONISALL_EXECUTION_TEST_PROMPT, maxRunsPerAgent: 4, maxTurns: 1, timeoutSec: 120, slots };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
    async evaluate(companyId: string, runId: string) {
      return db.transaction(async tx => {
        const conn = tx as unknown as Db; await scope(conn, companyId);
        const [run] = await conn.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
        if (!run?.issueId || !await visibleIssue(conn, companyId, run.issueId)) throw notFound("Development Run not found");
        const [agent] = await conn.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, run.agentId)));
        if (!agent || !executionTestPolicy(agent)?.issueIds.includes(run.issueId)) throw notFound("Development Run not found");
        return evaluateExecutionTest(run);
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
  };
}
