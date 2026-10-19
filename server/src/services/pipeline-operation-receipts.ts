import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  authUsers, companies, companyMemberships, pipelineOperationReceipts,
  pipelineCases, pipelineCaseEvents, pipelineAutomationExecutions,
  tryPipelineOperationCompanyLifecycle, lockPipelineOperationKey,
} from "@paperclipai/db";
import {
  canonicalPipelineOperationJson, pipelineOperationFactsSchema, pipelineOperationTransitionRequestSchema,
  PIPELINE_OPERATION_RECEIPT_LIMITS, type PipelineOperationFacts, type PipelineOperationReceipt,
  type PipelineOperationTransitionRequest,
} from "@paperclipai/shared";
import { and, eq, inArray, is, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { conflict, forbidden, notFound } from "../errors.js";
import { authorizationService, type AuthorizationActor } from "./authorization.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Row = typeof pipelineOperationReceipts.$inferSelect;
const unavailable = () => notFound("Pipeline resource not found");
const invalid = () => conflict("Unsupported or inconsistent operation receipt", { code: "operation_receipt_inconsistent" });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (bytes: string) => createHash("sha256").update(bytes, "utf8").digest("hex");

function identity(value: string): string {
  if (!uuid.test(value)) throw unavailable();
  return value.toLowerCase();
}

function boardContext(input: AuthorizationActor, companyId: string, writing: boolean): AuthorizationActor {
  if (input.type !== "board") throw forbidden("Board access required");
  if (writing && (!input.userId || ["board", "local-board"].includes(input.userId)
    || !["session", "board_key"].includes(input.source ?? ""))) {
    throw forbidden("Operation receipts require an authenticated persistent board user");
  }
  const actor: AuthorizationActor = {
    type: "board", source: input.source, userId: input.userId, sessionId: input.sessionId,
    companyIds: [...(input.companyIds ?? [])], isInstanceAdmin: input.isInstanceAdmin,
    ignoreInstanceAdmin: input.ignoreInstanceAdmin,
  };
  if (actor.source !== "local_implicit" && !actor.companyIds?.includes(companyId)) throw unavailable();
  Object.freeze(actor.companyIds);
  return Object.freeze(actor);
}

async function authorize(tx: Tx, actor: AuthorizationActor, companyId: string, writing: boolean) {
  if (actor.source !== "local_implicit") {
    if (!actor.userId) throw unavailable();
    const [user] = await tx.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, actor.userId)).limit(1);
    const [member] = await tx.select({ role: companyMemberships.membershipRole }).from(companyMemberships).where(and(
      eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, actor.userId), eq(companyMemberships.status, "active"),
    )).limit(1);
    if (!user || !member) throw unavailable();
    if (writing && member.role === "viewer") throw forbidden("Viewer access is read-only");
  }
  const access = authorizationService(tx);
  if (!(await access.decide({ actor, action: "company_scope:read", resource: { type: "company", companyId } })).allowed) throw unavailable();
  if (writing && !(await access.decide({ actor, action: "pipelines:write", resource: { type: "company", companyId } })).allowed) throw unavailable();
}

function requestFingerprint(companyId: string, caseId: string, userId: string, request: PipelineOperationTransitionRequest): string {
  // Credentials excluded. Presence of optional business fields is retained explicitly.
  const business: Record<string, unknown> = {
    protocol: "pipeline.operation.request.v1", rootKind: "case_transition",
    companyId, caseId, principalType: "user", principalId: userId,
    toStageKey: request.toStageKey, expectedVersion: String(request.expectedVersion),
  };
  for (const key of ["reason", "force", "acceptSuggestionId"] as const) {
    business[key] = Object.hasOwn(request, key) ? { present: true, value: request[key] } : { present: false };
  }
  return sha256(canonicalPipelineOperationJson(business));
}

function validateFacts(input: unknown, companyId: string, caseId?: string): PipelineOperationFacts {
  const result = pipelineOperationFactsSchema.safeParse(input);
  if (!result.success) throw invalid();
  const facts = result.data;
  if (Buffer.byteLength(canonicalPipelineOperationJson(facts), "utf8") > PIPELINE_OPERATION_RECEIPT_LIMITS.canonicalBytes) throw invalid();
  if (facts.companyId !== companyId || (caseId && facts.caseId !== caseId)
    || facts.returnedCase.id !== facts.caseId || facts.rootFinalCase.id !== facts.caseId
    || facts.primaryEvent.companyId !== companyId || facts.primaryEvent.caseId !== facts.caseId) throw invalid();
  if (BigInt(facts.returnedCase.version) !== BigInt(facts.expectedVersion) + 1n
    || BigInt(facts.rootFinalCase.version) < BigInt(facts.returnedCase.version)) throw invalid();
  const seen = new Set<string>();
  for (const ref of facts.knownExecutions) {
    if (ref.companyId !== companyId || seen.has(ref.executionId)) throw invalid();
    seen.add(ref.executionId);
  }
  if (facts.primaryExecutionId && !facts.knownExecutions.some(ref => ref.executionId === facts.primaryExecutionId
    && ref.caseId === facts.caseId && ref.eventId === facts.primaryEvent.eventId)) throw invalid();
  return facts;
}

/** Only selected identities, never a row payload/Issue/Run or dynamic native status. */
async function authorizeFacts(tx: Tx, actor: AuthorizationActor, facts: PipelineOperationFacts) {
  await authorize(tx, actor, facts.companyId, false);
  const caseIds = [...new Set([facts.caseId, ...facts.knownExecutions.map(ref => ref.caseId)])];
  const cases = await tx.select({ id: pipelineCases.id }).from(pipelineCases).where(and(
    inArray(pipelineCases.id, caseIds), eq(pipelineCases.companyId, facts.companyId),
  )).limit(65);
  if (cases.length !== caseIds.length) throw unavailable(); // Native Case read scope is Company; no Issue projection.
  const refs = [facts.primaryEvent, ...facts.knownExecutions];
  const events = await tx.select({ id: pipelineCaseEvents.id, caseId: pipelineCaseEvents.caseId }).from(pipelineCaseEvents).where(and(
    inArray(pipelineCaseEvents.id, [...new Set(refs.map(ref => ref.eventId))]), eq(pipelineCaseEvents.companyId, facts.companyId),
  )).limit(65);
  const eventById = new Map(events.map(row => [row.id, row]));
  if (refs.some(ref => eventById.get(ref.eventId)?.caseId !== ref.caseId)) throw unavailable();
  if (facts.knownExecutions.length) {
    const ledgers = await tx.select({ id: pipelineAutomationExecutions.id, caseId: pipelineAutomationExecutions.caseId,
      eventId: pipelineAutomationExecutions.triggeringEventId }).from(pipelineAutomationExecutions).where(and(
      inArray(pipelineAutomationExecutions.id, facts.knownExecutions.map(ref => ref.executionId)),
      eq(pipelineAutomationExecutions.companyId, facts.companyId),
    )).limit(64);
    const ledgerById = new Map(ledgers.map(row => [row.id, row]));
    if (facts.knownExecutions.some(ref => ledgerById.get(ref.executionId)?.caseId !== ref.caseId
      || ledgerById.get(ref.executionId)?.eventId !== ref.eventId)) throw unavailable();
  }
}

async function project(tx: Tx, actor: AuthorizationActor, row: Row, replayed: boolean, caseId?: string): Promise<PipelineOperationReceipt> {
  if (row.retentionDisposition !== "facts_preserved" || !row.rootFacts) throw unavailable();
  if (row.rootKind !== "case_transition" || row.protocolVersion !== 1 || row.provenanceVersion !== 1
    || row.requestCanonicalVersion !== 1 || row.factsVersion !== 1 || row.coverageKind !== "limited_root_result_v1"
    || row.principalType !== "user" || !row.principalId || ["board", "local-board"].includes(row.principalId)
    || row.epoch !== null || row.epochProvenance !== "legacy_unversioned" || row.retentionPolicyVersion !== 1) throw invalid();
  const facts = validateFacts(row.rootFacts, row.companyId, caseId);
  await authorizeFacts(tx, actor, facts);
  if (sha256(canonicalPipelineOperationJson(facts)) !== row.rootFactsSha256) throw invalid();
  return {
    operationId: row.operationId, rootEvidence: "exact_receipt_observed", coverageKind: "limited_root_result_v1",
    complete: false, facts, recordedAt: row.recordedAt.toISOString(), replayed, executionEligibility: "not_assessed",
  };
}

/** Trusted DB-only callback; returns a discriminated branch after the actual root finishes. */
export async function commitPipelineOperation<Result>(db: Db, input: {
  companyId: string; caseId: string; actor: AuthorizationActor; request: PipelineOperationTransitionRequest;
}, work: (tx: Tx) => Promise<{ result: Result; facts: PipelineOperationFacts }>): Promise<
  { kind: "replay"; receipt: PipelineOperationReceipt } | { kind: "new"; receipt: PipelineOperationReceipt; result: Result }
> {
  if (is(db, PgTransaction)) throw conflict("Operation receipt requires the root database", { code: "root_database_required" });
  const companyId = identity(input.companyId), caseId = identity(input.caseId);
  const actor = boardContext(input.actor, companyId, true);
  const request = pipelineOperationTransitionRequestSchema.parse(input.request);
  const fingerprint = requestFingerprint(companyId, caseId, actor.userId!, request);
  return db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '2s'`);
    await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '5s'`);
    const [company] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("key share");
    if (!company) throw unavailable();
    // Must not wait while holding KEY SHARE: remove's final DELETE upgrades its row lock.
    if (!(await tryPipelineOperationCompanyLifecycle(tx, companyId))) {
      throw conflict("Company lifecycle is busy", { code: "operation_company_lifecycle_busy" });
    }
    await authorize(tx, actor, companyId, true);
    await lockPipelineOperationKey(tx, companyId, request.operationId);
    // READ COMMITTED: this statement starts after arbitration, so sees the committed winner.
    const [existing] = await tx.select().from(pipelineOperationReceipts).where(and(
      eq(pipelineOperationReceipts.companyId, companyId), eq(pipelineOperationReceipts.operationId, request.operationId),
    )).limit(1);
    if (existing) {
      if (existing.principalType !== "user" || existing.principalId !== actor.userId) throw unavailable();
      const receipt = await project(tx, actor, existing, true);
      if (existing.requestFingerprint !== fingerprint || receipt.facts.caseId !== caseId) {
        throw conflict("Operation request binding conflict", { code: "operation_request_conflict" });
      }
      return { kind: "replay" as const, receipt };
    }
    const { result, facts: rawFacts } = await work(tx);
    const facts = validateFacts(rawFacts, companyId, caseId);
    if (facts.expectedVersion !== String(request.expectedVersion)) throw invalid();
    await authorizeFacts(tx, actor, facts);
    const [row] = await tx.insert(pipelineOperationReceipts).values({
      companyId, operationId: request.operationId, principalId: actor.userId!,
      requestFingerprint: fingerprint, rootFacts: facts, rootFactsSha256: sha256(canonicalPipelineOperationJson(facts)),
    }).returning(); // No conflict suppression, callback replay or root retry.
    if (!row) throw invalid();
    return { kind: "new" as const, result, receipt: await project(tx, actor, row, false, caseId) };
  }, { isolationLevel: "read committed", accessMode: "read write" });
}

export async function readPipelineOperationReceipt(db: Db, input: {
  companyId: string; operationId: string; actor: AuthorizationActor;
}): Promise<PipelineOperationReceipt> {
  if (is(db, PgTransaction)) throw conflict("Operation receipt observation requires the root database", { code: "root_database_required" });
  const companyId = identity(input.companyId), operationId = identity(input.operationId);
  const actor = boardContext(input.actor, companyId, false);
  return db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '2s'`);
    await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '5s'`);
    await authorize(tx, actor, companyId, false);
    const [row] = await tx.select().from(pipelineOperationReceipts).where(and(
      eq(pipelineOperationReceipts.companyId, companyId), eq(pipelineOperationReceipts.operationId, operationId),
    )).limit(1);
    if (!row) throw unavailable();
    return project(tx, actor, row, false);
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
