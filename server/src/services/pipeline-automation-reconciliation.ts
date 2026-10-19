import type { Db } from "@paperclipai/db";
import {
  companyMemberships, heartbeatRuns, issues, pipelineAutomationExecutions, pipelineCaseEvents,
  pipelineCaseIssueLinks, pipelineCases, routineRuns, routines,
} from "@paperclipai/db";
import type { PipelineAutomationReconciliation } from "@paperclipai/shared";
import { and, asc, eq, inArray, is, isNull, or, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { conflict, forbidden, notFound } from "../errors.js";
import { authorizationService, canActorReadIssuePrivacy, type AuthorizationActor } from "./authorization.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Reader = Pick<Tx, "select">;
const LIMITS = Object.freeze({ collection: 50, mergeDepth: 8, mergeNodes: 64, issues: 64, selectConstructions: 256, callbackBudgetMs: 10_000, statementBudgetMs: 2_000 });
const unavailable = () => notFound("Pipeline resource not found");
const budgetExceeded = () => conflict("Reconciliation observation budget exceeded", { code: "reconciliation_budget_exceeded" });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Controls stay in the root wrapper; the observer and native board ACL get select only. */
function boundedReader(tx: Tx, deadline: number): { reader: Reader; assertBudget: () => void } {
  let selections = 0;
  let queries = 0;
  const assertBudget = () => { if (performance.now() >= deadline) throw budgetExceeded(); };
  async function executeQuery(target: PromiseLike<unknown>) {
    assertBudget();
    if (++queries > LIMITS.selectConstructions) throw budgetExceeded();
    const remaining = Math.max(1, Math.floor(Math.min(LIMITS.statementBudgetMs, deadline - performance.now())));
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${remaining}ms'`));
    assertBudget();
    const result = await target;
    assertBudget();
    return result;
  }
  function wrap<T extends object>(target: T): T {
    return new Proxy(target, {
      get(value, key, receiver) {
        if (key === "then") return (resolve: (row: unknown) => unknown, reject: (error: unknown) => unknown) =>
          executeQuery(value as unknown as PromiseLike<unknown>).then(resolve, reject);
        if (key === "catch") return (reject: (error: unknown) => unknown) => executeQuery(value as unknown as PromiseLike<unknown>).catch(reject);
        if (key === "finally") return (finish: () => void) => executeQuery(value as unknown as PromiseLike<unknown>).finally(finish);
        if (!["from", "where", "innerJoin", "leftJoin", "orderBy", "limit"].includes(String(key))) throw conflict("Unsupported reconciliation read capability", { code: "reconciliation_read_capability_required" });
        const member = Reflect.get(value, key, receiver);
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          const next = Reflect.apply(member, value, args);
          return next && typeof next === "object" && (typeof next.then === "function" || typeof next.from === "function") ? wrap(next) : next;
        };
      },
    });
  }
  const select = new Proxy(tx.select, {
    apply(target, _receiver, args) {
      assertBudget();
      if (++selections > LIMITS.selectConstructions) throw budgetExceeded();
      return wrap(Reflect.apply(target, tx, args));
    },
  });
  return { reader: Object.freeze({ select }), assertBudget };
}

const runFields = {
  id: routineRuns.id, status: routineRuns.status, linkedIssueId: routineRuns.linkedIssueId,
  coalescedIntoRunId: routineRuns.coalescedIntoRunId, routineId: routineRuns.routineId, createdAt: routineRuns.createdAt,
  payloadCaseId: sql<string | null>`${routineRuns.triggerPayload}->'case'->>'id'`,
  payloadPipelineId: sql<string | null>`${routineRuns.triggerPayload}->'pipeline'->>'id'`,
  payloadEventId: sql<string | null>`${routineRuns.triggerPayload}->>'triggeringEventId'`,
};

export async function readPipelineAutomationReconciliation(db: Db, input: {
  companyId: string; caseId: string; executionId: string; actor: AuthorizationActor;
}): Promise<PipelineAutomationReconciliation> {
  if (is(db, PgTransaction)) throw conflict("Reconciliation requires the root database", { code: "root_database_required" });
  if (input.actor.type !== "board") throw forbidden("Board access required");
  const actor: AuthorizationActor = {
    type: "board", userId: input.actor.userId, sessionId: input.actor.sessionId,
    source: input.actor.source, isInstanceAdmin: input.actor.isInstanceAdmin,
    ignoreInstanceAdmin: input.actor.ignoreInstanceAdmin,
    companyIds: input.actor.companyIds ? [...input.actor.companyIds] : [],
  }; // Authentication context only; no cross-snapshot membership/authorization memo.
  Object.freeze(actor.companyIds);
  if (actor.source !== "local_implicit" && !actor.companyIds?.includes(input.companyId)) throw unavailable();
  return db.transaction(async (tx) => {
    const startedAt = new Date().toISOString();
    const deadline = performance.now() + LIMITS.callbackBudgetMs;
    await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '2s'`);
    const { reader, assertBudget } = boundedReader(tx, deadline);
    // Compatibility bridge for trusted native board read paths. Runtime object has no
    // execute/transaction/write methods: future capability use fails closed.
    const authorizationDb = reader as Tx;
    const access = authorizationService(authorizationDb);
    const [caseRow] = await reader.select({ id: pipelineCases.id, pipelineId: pipelineCases.pipelineId })
      .from(pipelineCases).where(and(eq(pipelineCases.id, input.caseId), eq(pipelineCases.companyId, input.companyId))).limit(1);
    if (!caseRow) throw unavailable();
    if (actor.source !== "local_implicit") {
      if (!actor.userId) throw unavailable();
      const [membership] = await reader.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
        eq(companyMemberships.companyId, input.companyId), eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, actor.userId), eq(companyMemberships.status, "active"),
      )).limit(1);
      if (!membership) throw unavailable();
    }
    if (!(await access.decide({ actor, action: "company_scope:read", resource: { type: "company", companyId: input.companyId } })).allowed) throw unavailable();
    const [ledger] = await reader.select({
      id: pipelineAutomationExecutions.id, companyId: pipelineAutomationExecutions.companyId, caseId: pipelineAutomationExecutions.caseId,
      routineId: pipelineAutomationExecutions.routineId, automationId: pipelineAutomationExecutions.automationId,
      triggeringEventId: pipelineAutomationExecutions.triggeringEventId, status: pipelineAutomationExecutions.status,
      executionIssueId: pipelineAutomationExecutions.executionIssueId, generation: pipelineAutomationExecutions.generation,
      pendingDispatch: sql<boolean>`${pipelineAutomationExecutions.error} = 'pending_dispatch'`,
      createdAt: pipelineAutomationExecutions.createdAt, updatedAt: pipelineAutomationExecutions.updatedAt,
    }).from(pipelineAutomationExecutions).where(and(
      eq(pipelineAutomationExecutions.id, input.executionId), eq(pipelineAutomationExecutions.companyId, input.companyId), eq(pipelineAutomationExecutions.caseId, input.caseId),
    )).limit(1);
    if (!ledger) throw unavailable();
    const truncated = new Set<string>();
    const limitations = new Set<string>(["no_operation_receipt", "no_frozen_configuration", "historical_deletion_possible", "external_effects_not_observed", "authentication_context_precedes_snapshot", "callback_budget_excludes_connection_and_commit"]);
    const contradictions = new Set<string>();
    function bounded<T>(rows: T[], relation: string): T[] {
      if (rows.length > LIMITS.collection) { truncated.add(relation); limitations.add("bounded_candidates"); }
      return rows.slice(0, LIMITS.collection);
    }
    const [event] = await reader.select({ id: pipelineCaseEvents.id, type: pipelineCaseEvents.type, createdAt: pipelineCaseEvents.createdAt })
      .from(pipelineCaseEvents).where(and(eq(pipelineCaseEvents.id, ledger.triggeringEventId), eq(pipelineCaseEvents.companyId, input.companyId), eq(pipelineCaseEvents.caseId, input.caseId))).limit(1);
    if (!event) limitations.add("triggering_event_unresolved");
    const [routine] = await reader.select({ id: routines.id }).from(routines)
      .where(and(eq(routines.id, ledger.routineId), eq(routines.companyId, input.companyId))).limit(1);
    if (!routine) limitations.add("routine_unresolved");
    const candidateRuns = await reader.select(runFields).from(routineRuns).where(and(
      eq(routineRuns.companyId, input.companyId), eq(routineRuns.routineId, ledger.routineId),
      eq(routineRuns.source, "api"), isNull(routineRuns.triggerId),
      eq(routineRuns.idempotencyKey, `pipeline:${ledger.caseId}:${ledger.automationId}:${ledger.triggeringEventId}`),
    )).orderBy(asc(routineRuns.createdAt), asc(routineRuns.id)).limit(LIMITS.collection + 1);
    if (candidateRuns.length > 1) contradictions.add("multiple_exact_routine_runs");
    for (const run of candidateRuns) {
      const materials = [run.payloadCaseId, run.payloadPipelineId, run.payloadEventId];
      if (materials.some((value) => value === null)) limitations.add("historical_payload_unresolved");
      if (materials.some((value, index) => value !== null && value.toLowerCase() !== [caseRow.id, caseRow.pipelineId, ledger.triggeringEventId][index])) contradictions.add("historical_payload_mismatch");
    }
    const issueFields = {
      id: issues.id, companyId: issues.companyId, status: issues.status, createdAt: issues.createdAt,
      visibility: issues.visibility, privacyRootIssueId: issues.privacyRootIssueId,
      responsibleUserId: issues.responsibleUserId, createdByUserId: issues.createdByUserId,
      assigneeUserId: issues.assigneeUserId, assigneeAgentId: issues.assigneeAgentId, projectId: issues.projectId,
      checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId,
      originKind: issues.originKind, originId: issues.originId, originRunId: issues.originRunId,
    };
    type IssueRow = typeof issues.$inferSelect;
    const observedIssues = new Map<string, Pick<IssueRow, keyof typeof issueFields>>();
    async function authorizeIssue(id: string | null) {
      if (!id) return;
      if (!uuid.test(id)) throw unavailable();
      id = id.toLowerCase();
      if (observedIssues.has(id)) return;
      if (observedIssues.size >= LIMITS.issues) throw budgetExceeded();
      const [issue] = await reader.select(issueFields).from(issues).where(and(eq(issues.id, id), eq(issues.companyId, input.companyId))).limit(1);
      // Strict predicate first: native shadow logging must not reveal a denied ID.
      if (!issue || !(await canActorReadIssuePrivacy(authorizationDb, actor, issue))) throw unavailable();
      if (!(await access.decide({ actor, action: "issue:read", resource: { type: "issue", companyId: input.companyId, issueId: issue.id, projectId: issue.projectId } })).allowed) throw unavailable();
      observedIssues.set(issue.id, issue);
    }
    await authorizeIssue(ledger.executionIssueId);
    type RunRow = (typeof candidateRuns)[number];
    const candidateRunIds = new Set(candidateRuns.map((run) => run.id));
    const allRuns = new Map<string, RunRow>(candidateRuns.map((run) => [run.id, run]));
    const processed = new Set<string>();
    const validatedEdges = new Map<string, string>();
    async function inspectRun(run: RunRow, depth: number, path: Set<string>): Promise<void> {
      await authorizeIssue(run.linkedIssueId);
      if (path.has(run.id)) { contradictions.add("merge_cycle"); return; }
      if (processed.has(run.id)) return;
      if (!run.linkedIssueId) limitations.add("routine_issue_unresolved");
      if (!run.coalescedIntoRunId) { processed.add(run.id); return; }
      if (depth >= LIMITS.mergeDepth || allRuns.size >= LIMITS.mergeNodes) { truncated.add("merge_graph"); limitations.add("merge_graph_unresolved"); return; }
      let target = allRuns.get(run.coalescedIntoRunId);
      if (!target) {
        [target] = await reader.select(runFields).from(routineRuns)
          .where(and(eq(routineRuns.id, run.coalescedIntoRunId), eq(routineRuns.companyId, input.companyId))).limit(1);
        if (!target) throw unavailable();
        allRuns.set(target.id, target);
      }
      await authorizeIssue(target.linkedIssueId);
      if (target.routineId !== ledger.routineId || (run.linkedIssueId && target.linkedIssueId && run.linkedIssueId !== target.linkedIssueId)) contradictions.add("merge_relation_mismatch");
      validatedEdges.set(run.id, target.id);
      await inspectRun(target, depth + 1, new Set([...path, run.id]));
      processed.add(run.id);
    }
    for (const run of candidateRuns) await inspectRun(run, 0, new Set());
    const exactRuns = bounded(candidateRuns, "exact_routine_runs");
    const knownIds = [...observedIssues.keys()];
    const candidateLinks = await reader.select({ id: pipelineCaseIssueLinks.id, issueId: pipelineCaseIssueLinks.issueId, role: pipelineCaseIssueLinks.role, automationAttemptId: pipelineCaseIssueLinks.automationAttemptId, retiredAt: pipelineCaseIssueLinks.retiredAt, createdAt: pipelineCaseIssueLinks.createdAt })
      .from(pipelineCaseIssueLinks).where(and(eq(pipelineCaseIssueLinks.companyId, input.companyId), eq(pipelineCaseIssueLinks.caseId, input.caseId),
        or(eq(pipelineCaseIssueLinks.automationAttemptId, ledger.id), knownIds.length ? inArray(pipelineCaseIssueLinks.issueId, knownIds) : sql`false`),
      )).orderBy(asc(pipelineCaseIssueLinks.createdAt), asc(pipelineCaseIssueLinks.id)).limit(LIMITS.collection + 1);
    for (const link of candidateLinks) await authorizeIssue(link.issueId);
    if (candidateLinks.some((link) => link.automationAttemptId === ledger.id && link.role !== "automation")) contradictions.add("link_role_mismatch");
    const linkRows = bounded(candidateLinks, "case_issue_links");
    if (!linkRows.some((link) => link.automationAttemptId === ledger.id && link.role === "automation")) limitations.add("exact_attempt_link_unresolved");
    const issueIds = [...observedIssues.keys()];
    const pointerIds = [...new Set([...observedIssues.values()].flatMap((issue) => [issue.checkoutRunId, issue.executionRunId]).filter((id): id is string => !!id))];
    const heartbeatFields = {
      id: heartbeatRuns.id, status: heartbeatRuns.status, issueId: heartbeatRuns.issueId, scopeKind: heartbeatRuns.scopeKind, createdAt: heartbeatRuns.createdAt,
      nativeIssueId: heartbeatRuns.nativeIssueId,
      contextIssueId: sql<string | null>`${heartbeatRuns.contextSnapshot}->>'issueId'`,
      contextTaskId: sql<string | null>`${heartbeatRuns.contextSnapshot}->>'taskId'`,
    };
    const candidateBeats = issueIds.length ? await reader.select(heartbeatFields).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), or(
      inArray(heartbeatRuns.issueId, issueIds), pointerIds.length ? inArray(heartbeatRuns.id, pointerIds) : sql`false`,
      inArray(sql`lower(${heartbeatRuns.contextSnapshot}->>'issueId')`, issueIds), inArray(sql`lower(${heartbeatRuns.contextSnapshot}->>'taskId')`, issueIds),
    ))).orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id)).limit(LIMITS.collection + 1) : [];
    for (const beat of candidateBeats) {
      // The native company-scope shortcut does not authorize legacy Issue references.
      for (const id of [beat.issueId, beat.nativeIssueId, beat.contextIssueId, beat.contextTaskId]) await authorizeIssue(id);
      const refs = [beat.issueId, beat.contextIssueId, beat.contextTaskId].filter((id): id is string => !!id).map((id) => id.toLowerCase());
      const nativeIssueId = beat.nativeIssueId?.toLowerCase();
      if (new Set(refs).size > 1 || (nativeIssueId && refs.some((id) => id !== nativeIssueId)) || (beat.scopeKind === "company" && beat.issueId)) contradictions.add("heartbeat_issue_mismatch");
      if (beat.scopeKind === "issue" && !beat.issueId) throw unavailable();
    }
    const beats = bounded(candidateBeats, "heartbeat_runs");
    for (const id of pointerIds) {
      if (!beats.some((beat) => beat.id === id)) limitations.add("heartbeat_pointer_unresolved");
    }
    // Current Issue origin metadata is cross-checking material, never a substitute
    // for exact run matching. No unverified origin/retry reference is serialized.
    for (const issue of observedIssues.values()) {
      const originRunId = issue.originRunId?.toLowerCase();
      if (originRunId && allRuns.has(originRunId)) {
        if (issue.originKind === "routine_execution" && issue.originId !== ledger.routineId) contradictions.add("issue_origin_mismatch");
        if (issue.originKind !== "routine_execution") limitations.add("issue_origin_metadata_unresolved");
      }
      if (originRunId && !allRuns.has(originRunId)) limitations.add("issue_origin_unresolved");
    }
    if (ledger.executionIssueId && !candidateRuns.length) limitations.add("routine_run_unresolved");
    if (ledger.executionIssueId && candidateRuns.length && !candidateRuns.some((run) => run.linkedIssueId === ledger.executionIssueId)) {
      if (truncated.has("exact_routine_runs")) limitations.add("ledger_issue_unresolved");
      else contradictions.add("ledger_issue_mismatch");
    }
    if (ledger.status === "succeeded" && !ledger.executionIssueId) limitations.add("ledger_issue_unresolved");
    assertBudget();
    const projectRun = (run: RunRow) => ({ id: run.id, status: run.status, linkedIssueId: run.linkedIssueId, coalescedIntoRunId: validatedEdges.get(run.id) ?? null, createdAt: run.createdAt.toISOString() });
    const unresolved = !event || !routine || truncated.size > 0 || [...limitations].some((reason) => reason.endsWith("_unresolved"));
    return {
      scope: { companyId: ledger.companyId, caseId: ledger.caseId, executionId: ledger.id },
      observation: { startedAt, completedAt: new Date().toISOString(), isolation: "repeatable_read", access: "read_only" },
      rootEvidence: event && routine ? "native_records_observed" : "unresolved",
      dispatchEvidence: contradictions.size ? "contradictory" : unresolved ? "unresolved" : observedIssues.size ? "linked_records_observed" : exactRuns.length ? "routine_records_observed" : "none_observed",
      coverage: { complete: false, truncated: [...truncated].sort(), limitations: [...limitations].sort(), contradictions: [...contradictions].sort(), limits: LIMITS },
      nativeFacts: {
        ledger: { id: ledger.id, status: ledger.status, pendingDispatch: ledger.pendingDispatch === true, generation: ledger.generation, createdAt: ledger.createdAt.toISOString(), updatedAt: ledger.updatedAt.toISOString() },
        triggeringEvent: event ? { id: event.id, type: event.type, createdAt: event.createdAt.toISOString() } : null,
        routineRuns: exactRuns.map(projectRun), mergedRoutineRuns: [...allRuns.values()].filter((run) => !candidateRunIds.has(run.id)).map(projectRun),
        issues: [...observedIssues.values()].map((issue) => ({ id: issue.id, status: issue.status, createdAt: issue.createdAt.toISOString() })),
        links: linkRows.map((link) => ({ id: link.id, issueId: link.issueId, role: link.role, exactAttempt: link.automationAttemptId === ledger.id && link.role === "automation", retired: !!link.retiredAt, createdAt: link.createdAt.toISOString() })),
        heartbeatRuns: beats.map((beat) => ({ id: beat.id, status: beat.status, issueId: beat.issueId, scopeKind: beat.scopeKind, createdAt: beat.createdAt.toISOString() })),
      },
      executionEligibility: "not_assessed", allowedActions: ["read", "reconcile"],
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
