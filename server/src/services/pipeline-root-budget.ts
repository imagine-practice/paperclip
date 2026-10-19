import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { Db } from "@paperclipai/db";
import { PostgresJsTransaction } from "drizzle-orm/postgres-js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Unconnected foundation. These limits confer no journal coverage or authority. */
export const PIPELINE_ROOT_BUDGET_PROFILE = Object.freeze({
  version: 1, cases: 128, events: 512, executions: 128, otherMutations: 512,
  transitions: 512, mutations: 2048, attempts: 512, frames: 1024, depth: 32,
  returnedRows: 4096, selects: 2048, batchRows: 129, referencesAndLocks: 1024,
  envelopeBytes: 1024 * 1024, rootMs: 15_000, statementMs: 2000, lockMs: 2000, idleMs: 5000,
});

type Failure = "budget" | "coverage" | "scope" | "deadline";
export class JournalBudgetExceeded extends Error {
  readonly code = "journal_budget_exceeded";
  constructor() { super("Pipeline root budget exceeded"); this.name = "JournalBudgetExceeded"; Object.freeze(this); }
}
export class JournalCoverageViolation extends Error {
  readonly code = "journal_coverage_violation";
  constructor() { super("Pipeline root coverage is unavailable"); this.name = "JournalCoverageViolation"; Object.freeze(this); }
}
export class JournalScopeViolation extends Error {
  readonly code = "journal_scope_violation";
  constructor() { super("Pipeline root scope is unavailable"); this.name = "JournalScopeViolation"; Object.freeze(this); }
}
export class JournalDeadlineExceeded extends Error {
  readonly code = "journal_deadline_exceeded";
  constructor() { super("Pipeline root deadline exceeded"); this.name = "JournalDeadlineExceeded"; Object.freeze(this); }
}
type Fatal = JournalBudgetExceeded | JournalCoverageViolation | JournalScopeViolation | JournalDeadlineExceeded;

const MUTATION_KINDS = ["case_transition_update", "case_lease_expiration_update", "case_parent_counter_update",
  "case_event_insert", "automation_execution_insert", "issue_comment_insert", "issue_timestamp_update"] as const;
export type PipelineBudgetMutationKind = typeof MUTATION_KINDS[number];
const REF_KINDS = ["company", "case", "pipeline", "stage", "transition", "blocker", "case_issue_link",
  "issue", "comment", "event", "execution", "routine", "binding", "project", "issue_access_grant",
  "project_access_member", "company_membership", "permission_grant", "auth_user", "instance_role",
  "lifecycle_key", "operation_key"] as const;
export type PipelineBudgetReferenceKind = typeof REF_KINDS[number];
export interface PipelineBudgetReference { readonly companyId: string; readonly kind: PipelineBudgetReferenceKind; readonly id: string; }
declare const contextBrand: unique symbol;
export interface PipelineRootBudgetContext {
  readonly [contextBrand]: true;
  readonly companyId: string;
  readonly caseId: string;
  readonly operationId: string;
  readonly profileVersion: 1;
}
declare const frameBrand: unique symbol;
export interface PipelineBudgetFrame { readonly [frameBrand]: true; }
export interface PipelineBudgetSqlLimits {
  readonly statementMs: number; readonly lockMs: number; readonly idleMs: number;
}
type Counts = Record<PipelineBudgetMutationKind, number>;
interface State {
  readonly tx: Tx; readonly context: PipelineRootBudgetContext; readonly deadline: number;
  active: boolean; fatal: Fatal | null; inFlight: boolean; pending: Promise<void> | null;
  readonly refs: Set<string>; readonly cases: Set<string>; readonly locks: Set<string>;
  readonly frames: Set<PipelineBudgetFrame>; readonly mutations: Counts; readonly reserved: Counts;
  selects: number; returnedRows: number; rowCapacity: number; attempts: number; frameCount: number; envelopeBytes: number;
}
const states = new WeakMap<PipelineRootBudgetContext, State>();
const transactions = new WeakMap<Tx, State>(); // Never delete: closed tx cannot rebuild its counters.
const frameOwners = new WeakMap<PipelineBudgetFrame, State>();
const scopes = new AsyncLocalStorage<State>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const profile = PIPELINE_ROOT_BUDGET_PROFILE;

function fatal(state: State | undefined, kind: Failure): Fatal {
  if (state?.fatal) return state.fatal;
  const error = kind === "budget" ? new JournalBudgetExceeded() : kind === "scope" ? new JournalScopeViolation()
    : kind === "deadline" ? new JournalDeadlineExceeded() : new JournalCoverageViolation();
  if (state) state.fatal = error;
  return error;
}
function reject(state: State, kind: Failure): never { throw fatal(state, kind); }
function healthy(state: State): void {
  if (state.fatal) throw state.fatal;
  if (!state.active) reject(state, "coverage");
  if (performance.now() >= state.deadline) reject(state, "deadline");
}
function stateFor(context: PipelineRootBudgetContext): State {
  const state = states.get(context), current = scopes.getStore();
  if (!state) throw fatal(current, "coverage");
  if (current !== state) {
    fatal(state, "scope");
    throw fatal(current ?? state, "scope");
  }
  healthy(state); return state;
}
function integer(state: State, value: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) reject(state, "coverage");
}
function add(state: State, current: number, delta: number, limit: number): number {
  integer(state, delta);
  const next = current + delta;
  if (!Number.isSafeInteger(next) || next > limit) reject(state, "budget");
  return next;
}
function uuid(value: string, state?: State): string {
  if (typeof value !== "string" || !UUID.test(value)) throw fatal(state, "scope");
  return value.toLowerCase();
}
function emptyCounts(): Counts { return Object.fromEntries(MUTATION_KINDS.map(kind => [kind, 0])) as Counts; }
// Boolean guard preserves Db's concrete schema generics; it does not attest root provenance.
function isDriverTransaction(value: unknown): boolean { return value instanceof PostgresJsTransaction; }
function mutationTotals(counts: Counts) {
  return { events: counts.case_event_insert, executions: counts.automation_execution_insert,
    transitions: counts.case_transition_update,
    other: counts.case_lease_expiration_update + counts.case_parent_counter_update + counts.issue_comment_insert + counts.issue_timestamp_update,
    total: MUTATION_KINDS.reduce((sum, kind) => sum + counts[kind], 0) };
}
function reserveMutation(state: State, kind: PipelineBudgetMutationKind): void {
  if (!MUTATION_KINDS.includes(kind)) reject(state, "coverage");
  const projected = emptyCounts();
  for (const key of MUTATION_KINDS) projected[key] = state.mutations[key] + state.reserved[key] + (key === kind ? 1 : 0);
  const totals = mutationTotals(projected);
  if (totals.events > profile.events || totals.executions > profile.executions || totals.transitions > profile.transitions
    || totals.other > profile.otherMutations || totals.total > profile.mutations) reject(state, "budget");
  state.reserved[kind]++;
}
function limits(state: State): PipelineBudgetSqlLimits {
  healthy(state);
  const remaining = Math.floor(state.deadline - performance.now());
  if (remaining < 1) reject(state, "deadline"); // PostgreSQL timeout=0 would disable the timeout.
  return Object.freeze({ statementMs: Math.min(profile.statementMs, remaining),
    lockMs: Math.min(profile.lockMs, remaining), idleMs: Math.min(profile.idleMs, remaining) });
}

/** One controlled leaf at a time. Caller must apply SQL limits and return real DB rows.
 * Does not intercept raw SQL, cancel work, open a transaction, retry, or classify native gates. */
function leaf<T>(state: State, work: (sqlLimits: PipelineBudgetSqlLimits) => Promise<T>): Promise<T> {
  healthy(state);
  if (state.inFlight) reject(state, "coverage");
  state.inFlight = true;
  const result = Promise.resolve().then(async () => {
    healthy(state);
    try {
      const value = await work(limits(state));
      healthy(state);
      return value;
    } catch {
      throw fatal(state, "coverage"); // No raw SQL error/cause in the public fatal.
    }
  }).finally(() => { state.inFlight = false; state.pending = null; });
  state.pending = result.then(() => {}, () => {}); // Observe escaped rejection; root drains registered work.
  return result;
}

/** Called FIRST in an existing trusted root's tx callback, then awaited by that owner.
 * Actual driver class identity is checked, but savepoints share that class: root provenance
 * remains the owner's obligation. No business caller currently uses this module. */
export async function withPipelineRootBudget<T>(
  tx: Tx,
  identity: { readonly companyId: string; readonly caseId: string; readonly operationId: string },
  work: (context: PipelineRootBudgetContext) => Promise<T>,
): Promise<T> {
  const current = scopes.getStore();
  if (current) throw fatal(current, "coverage");
  if (!isDriverTransaction(tx)) throw new JournalCoverageViolation();
  const previous = transactions.get(tx);
  if (previous) throw fatal(previous, "coverage");
  const context = Object.freeze({ companyId: uuid(identity.companyId), caseId: uuid(identity.caseId),
    operationId: uuid(identity.operationId), profileVersion: 1 as const }) as PipelineRootBudgetContext;
  const state: State = { tx, context, deadline: performance.now() + profile.rootMs, active: true,
    fatal: null, inFlight: false, pending: null, refs: new Set(), cases: new Set(), locks: new Set(), frames: new Set(),
    mutations: emptyCounts(), reserved: emptyCounts(), selects: 0, returnedRows: 0, rowCapacity: 0,
    attempts: 0, frameCount: 0, envelopeBytes: 0 };
  transactions.set(tx, state); states.set(context, state);
  return scopes.run(state, async () => {
    try {
      registerPipelineBudgetReference(context, { companyId: context.companyId, kind: "case", id: context.caseId });
      const result = await work(context);
      healthy(state);
      if (state.inFlight || state.frames.size || state.rowCapacity || MUTATION_KINDS.some(kind => state.reserved[kind])) reject(state, "coverage");
      return result;
    } catch {
      throw fatal(state, "coverage");
    } finally {
      // Never abandon registered in-flight work via Promise.race and claim rollback.
      if (state.pending) await state.pending;
      state.active = false; // Closed capability != COMMIT acknowledgement or released locks.
    }
  });
}

export function assertPipelineBudgetHealthy(context: PipelineRootBudgetContext): void { stateFor(context); }
/** Trusted readers must execute on the exact transaction registered by this context. */
export function assertPipelineBudgetTransaction(context: PipelineRootBudgetContext, tx: unknown): void {
  const state = stateFor(context);
  if (state.tx !== tx) reject(state, "scope");
}

export function failPipelineRootBudget(context: PipelineRootBudgetContext, kind: Failure): never {
  const state = stateFor(context);
  reject(state, ["budget", "coverage", "scope", "deadline"].includes(kind) ? kind : "coverage");
}
export function consumePipelineBudgetAttempt(context: PipelineRootBudgetContext): void {
  const state = stateFor(context); state.attempts = add(state, state.attempts, 1, profile.attempts);
}
export function enterPipelineBudgetFrame(context: PipelineRootBudgetContext): PipelineBudgetFrame {
  const state = stateFor(context); state.frameCount = add(state, state.frameCount, 1, profile.frames);
  const frame = Object.freeze({}) as PipelineBudgetFrame;
  state.frames.add(frame); frameOwners.set(frame, state); return frame;
}
/** Use finally around trusted helper frames. Expected native refusals stay native decisions. */
export function leavePipelineBudgetFrame(context: PipelineRootBudgetContext, frame: PipelineBudgetFrame): void {
  const state = stateFor(context), owner = frameOwners.get(frame);
  if (owner !== state || !state.frames.has(frame)) {
    if (owner) fatal(owner, "scope");
    reject(state, "coverage");
  }
  state.frames.delete(frame); // No decrement of cumulative frameCount.
}
export function assertPipelineBudgetDepth(context: PipelineRootBudgetContext, depth: number): void {
  const state = stateFor(context); integer(state, depth);
  if (depth > profile.depth) reject(state, "budget");
}
export function registerPipelineBudgetReference(context: PipelineRootBudgetContext, ref: PipelineBudgetReference, lock = false): void {
  const state = stateFor(context);
  if (!ref || typeof ref !== "object" || typeof lock !== "boolean") reject(state, "coverage");
  if (uuid(ref.companyId, state) !== context.companyId) reject(state, "scope");
  if (!REF_KINDS.includes(ref.kind)) reject(state, "coverage");
  const id = ref.kind === "auth_user" ? ref.id : uuid(ref.id, state);
  if (typeof id !== "string" || !id.length || id.includes("\0") || Buffer.byteLength(id, "utf8") > 256) reject(state, "scope");
  if ((ref.kind === "company" || ref.kind === "lifecycle_key") && id !== context.companyId) reject(state, "scope");
  if (ref.kind === "operation_key" && id !== context.operationId) reject(state, "scope");
  const key = `${context.companyId}|${ref.kind}|${id}`;
  if (!state.refs.has(key)) {
    add(state, state.refs.size, 1, profile.referencesAndLocks);
    if (ref.kind === "case") add(state, state.cases.size, 1, profile.cases);
    state.refs.add(key);
    if (ref.kind === "case") state.cases.add(key);
  }
  if (lock) state.locks.add(key); // Union shares the reference cap; this is declared, not proof of a DB lock.
}
export function chargePipelineEnvelopeChunk(context: PipelineRootBudgetContext, chunk: string): void {
  const state = stateFor(context);
  if (typeof chunk !== "string") reject(state, "coverage");
  state.envelopeBytes = add(state, state.envelopeBytes, Buffer.byteLength(chunk, "utf8"), profile.envelopeBytes);
  healthy(state); // Cooperative; already allocated strings are not sandboxed by this counter.
}
export function assertPipelineFinalEnvelopeBytes(context: PipelineRootBudgetContext, bytes: number): void {
  const state = stateFor(context); integer(state, bytes);
  if (bytes > profile.envelopeBytes) reject(state, "budget");
  if (bytes !== state.envelopeBytes) reject(state, "coverage");
}

/** Holds return capacity before SQL, charges actual rows only; empty/repeated queries still count. */
export function runPipelineBudgetSelect<T>(
  context: PipelineRootBudgetContext, maxRows: number,
  work: (limits: PipelineBudgetSqlLimits & { readonly maxRows: number }) => Promise<readonly T[]>,
): Promise<readonly T[]> {
  const state = stateFor(context);
  if (state.inFlight) reject(state, "coverage");
  integer(state, maxRows, 1);
  if (maxRows > profile.batchRows) reject(state, "budget");
  state.selects = add(state, state.selects, 1, profile.selects);
  add(state, state.returnedRows + state.rowCapacity, maxRows, profile.returnedRows);
  state.rowCapacity += maxRows;
  return leaf(state, async sqlLimits => {
    const rows = await work(Object.freeze({ ...sqlLimits, maxRows }));
    healthy(state);
    if (!Array.isArray(rows)) reject(state, "coverage");
    if (rows.length > maxRows) reject(state, "budget");
    state.returnedRows = add(state, state.returnedRows, rows.length, profile.returnedRows);
    state.rowCapacity -= maxRows; // Unused capacity was never charged as actual returned rows.
    return rows;
  });
}
/** All seven selected root writes affect one row. Only native ledger conflict may return none.
 * This trusted leaf accepts real RETURNING, not a caller's boolean no_insert or winner identity. */
export function runPipelineBudgetMutation<T>(
  context: PipelineRootBudgetContext, kind: PipelineBudgetMutationKind,
  work: (limits: PipelineBudgetSqlLimits) => Promise<readonly T[]>,
): Promise<readonly T[]> {
  const state = stateFor(context);
  if (state.inFlight) reject(state, "coverage");
  reserveMutation(state, kind);
  return leaf(state, async sqlLimits => {
    const rows = await work(sqlLimits);
    healthy(state);
    if (!Array.isArray(rows) || rows.length > 1 || (rows.length === 0 && kind !== "automation_execution_insert")) reject(state, "coverage");
    state.reserved[kind]--; // Trusted settle; unknown/rejected work never reaches here.
    state.mutations[kind] += rows.length; // Repeated identities remain repeated actions.
    return rows;
  });
}

/** Internal diagnostics only: no IDs, DB handles, sets, first error cause, or complete/grant flag. */
export function pipelineBudgetSnapshot(context: PipelineRootBudgetContext) {
  const state = stateFor(context);
  return Object.freeze({ profileVersion: profile.version, distinctCases: state.cases.size,
    referencesAndLocks: state.refs.size, declaredLockObjects: state.locks.size,
    selects: state.selects, returnedRows: state.returnedRows, heldRowCapacity: state.rowCapacity,
    attempts: state.attempts, frames: state.frameCount, openFrames: state.frames.size,
    envelopeBytes: state.envelopeBytes, mutations: Object.freeze({ ...state.mutations }),
    reservedMutations: Object.freeze({ ...state.reserved }) });
}
