import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { z } from "zod";
import { ONISALL_EXECUTION_TEST_MODEL, ONISALL_EXECUTION_TEST_PROMPT, ONISALL_EXECUTION_TEST_REASON } from "@paperclipai/shared";
import { conflict, forbidden } from "../../errors.js";
import { accessService } from "../access.js";
import type { AuthorizationActor } from "../authorization.js";

type Agent = typeof agents.$inferSelect;
type Conn = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
async function assertCurrentWakePermission(conn: Conn, agent: Agent, userId: string | null | undefined, context: Record<string, unknown> | null | undefined) {
  if (!userId || context?.onisallDirectBoard !== true) throw forbidden("Direct board identity required");
  const source = context.onisallBoardSource;
  if (source !== "local_implicit" && source !== "session") throw forbidden("Direct board session required");
  const actor: AuthorizationActor = { type: "board", userId, source, isInstanceAdmin: context.onisallInstanceAdmin === true };
  const decision = await accessService(conn as Db).decide({ actor, action: "agent:wake",
    resource: { type: "agent", companyId: agent.companyId, agentId: agent.id } });
  if (!decision.allowed) throw forbidden("Current native wake permission required");
  return actor;
}
async function assertIssueVisible(conn: Conn, actor: AuthorizationActor, issue: typeof issues.$inferSelect) {
  const decision = await accessService(conn as Db).decide({ actor, action: "issue:read", resource: {
    type: "issue", companyId: issue.companyId, issueId: issue.id, projectId: issue.projectId, parentIssueId: issue.parentId,
    assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId } });
  if (!decision.allowed) throw forbidden("Current native issue read permission required");
}
const policySchema = z.strictObject({ version: z.literal(1), task: z.literal("ONS-0024"),
  issueIds: z.array(z.string().uuid()).min(1).max(4).refine(ids => new Set(ids).size === ids.length) });
export function executionTestPolicy(agent: Pick<Agent, "metadata">) {
  if (!agent.metadata || !("onisallExecutionTest" in agent.metadata)) return null;
  const parsed = policySchema.safeParse(agent.metadata.onisallExecutionTest);
  if (!parsed.success) throw conflict("Development execution policy is invalid");
  return parsed.data;
}
export function executionTestConfigurationMatches(agent: Pick<Agent, "adapterType" | "adapterConfig" | "runtimeConfig">,
  config: Record<string, unknown> = agent.adapterConfig) {
  const heartbeat = agent.runtimeConfig.heartbeat as Record<string, unknown> | undefined;
  return agent.adapterType === "commandcode_local" && config.qualificationMode === true
    && config.model === ONISALL_EXECUTION_TEST_MODEL && config.effort === "low"
    && config.promptTemplate === ONISALL_EXECUTION_TEST_PROMPT && config.maxTurns === 1 && config.timeoutSec === 120
    && config.authMode === "commandcode" && config.resume !== true
    && config.spendAuthorizationRef === "docs/work/tasks/ONS-0024-preparation-browsing.md"
    && heartbeat?.enabled === false && heartbeat.wakeOnDemand === true && heartbeat.maxConcurrentRuns === 1;
}
export function assertExecutionTestRequest(agent: Agent, issueId: string | null | undefined, options: {
  manualUserWake?: boolean; requestedByActorType?: string | null; requestedByActorId?: string | null;
  reason?: string | null; contextSnapshot?: Record<string, unknown> | null;
}) {
  const policy = executionTestPolicy(agent);
  if (!policy) return;
  if (!options.manualUserWake || options.requestedByActorType !== "user" || !options.requestedByActorId
    || options.contextSnapshot?.onisallDirectBoard !== true
    || options.contextSnapshot.forceFreshSession !== true || options.reason !== ONISALL_EXECUTION_TEST_REASON) {
    throw forbidden("Development tests require a fresh manual direct-board request");
  }
  if (!issueId || !policy.issueIds.includes(issueId)) throw forbidden("Issue is outside the development test slots");
  if (!executionTestConfigurationMatches(agent)) throw conflict("Development execution configuration changed");
}

/** Inside the existing native issue-lock transaction, before creating a Run. */
export async function admitExecutionTest(conn: Conn, agent: Agent, issueId: string,
  options: { requestedByActorId?: string | null; contextSnapshot?: Record<string, unknown> | null }) {
  if (!executionTestPolicy(agent)) return;
  await conn.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`onisall-execution-test:${agent.id}`}, 0))`);
  const actor = await assertCurrentWakePermission(conn, agent, options.requestedByActorId, options.contextSnapshot);
  const [current] = await conn.select().from(agents).where(eq(agents.id, agent.id));
  const [company] = await conn.select().from(companies).where(eq(companies.id, agent.companyId));
  const [issue] = await conn.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)));
  if (!current || !executionTestPolicy(current)?.issueIds.includes(issueId) || !executionTestConfigurationMatches(current)
    || !["idle", "running"].includes(current.status) || company?.status !== "active"
    || !issue || issue.assigneeAgentId !== agent.id || issue.projectId || issue.parentId || issue.hiddenAt || issue.visibility !== "open"
    || !["todo", "in_progress"].includes(issue.status)) throw conflict("Development slot or current configuration is unavailable");
  await assertIssueVisible(conn, actor, issue);
  const previous = await conn.select({ id: heartbeatRuns.id, issueId: heartbeatRuns.issueId, status: heartbeatRuns.status })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id)));
  if (previous.some(run => run.issueId === issueId)) throw conflict("Single-use slot already dispatched; read its existing Run");
  if (previous.length >= 4) throw conflict("Development execution allowance exhausted");
  const active = await conn.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, agent.companyId), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"])));
  if (active.length) throw conflict("Wait until company Runs finish before starting a development test");
}

/** Recheck the effective native configuration immediately before adapter entry. */
export async function assertExecutionTestDispatch(db: Db, agent: Agent, run: typeof heartbeatRuns.$inferSelect,
  config: Record<string, unknown>) {
  if (!executionTestPolicy(agent)) return;
  const actor = await assertCurrentWakePermission(db, agent, typeof run.contextSnapshot?.actorId === "string" ? run.contextSnapshot.actorId : null, run.contextSnapshot);
  if (run.scopeKind !== "issue" || !run.issueId) throw conflict("Development dispatch requires an issue-bound native Run");
  const [currentRun] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.issueId, run.issueId)));
  if (currentRun?.status !== "running") throw conflict("Development native Run is not running");
  const [current] = await db.select().from(agents).where(eq(agents.id, agent.id));
  const [company] = await db.select().from(companies).where(eq(companies.id, agent.companyId));
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, run.issueId!), eq(issues.companyId, agent.companyId)));
  if (!current || !executionTestPolicy(current)?.issueIds.includes(run.issueId ?? "")
    || !executionTestConfigurationMatches(current) || !executionTestConfigurationMatches(current, config)
    || company?.status !== "active" || !issue || issue.projectId || issue.parentId || issue.hiddenAt || issue.visibility !== "open"
    || issue.assigneeAgentId !== agent.id || !["todo", "in_progress"].includes(issue.status)
    || run.contextSnapshot?.onisallDirectBoard !== true || run.contextSnapshot.forceFreshSession !== true) {
    throw conflict("Development execution changed before adapter dispatch");
  }
  await assertIssueVisible(db, actor, issue);
  // Same-Run recovery must also consume this allowance only once. Persist the
  // receipt on the native Agent, whose lifecycle updates preserve metadata.
  // A crash after reservation consumes the attempt; it cannot authorize replay.
  const reserved = await db.update(agents).set({ metadata: sql`
    coalesce(${agents.metadata}, '{}'::jsonb) || jsonb_build_object('onisallExecutionTestDispatches',
      coalesce(${agents.metadata}->'onisallExecutionTestDispatches', '{}'::jsonb) ||
      jsonb_build_object(${run.id}::text, jsonb_build_object('issueId', ${run.issueId}::text, 'reservedAt', now()::text)))` })
    .where(and(eq(agents.id, agent.id),
      sql`${agents.metadata}->'onisallExecutionTest' = ${JSON.stringify(executionTestPolicy(current))}::jsonb`,
      sql`${agents.adapterConfig} = ${JSON.stringify(current.adapterConfig)}::jsonb`,
      sql`${agents.metadata}->'onisallExecutionTestDispatches'->${run.id}::text is null`)).returning({ id: agents.id });
  if (reserved.length !== 1) throw conflict("Development adapter dispatch already reserved or configuration changed; no replay");
}
