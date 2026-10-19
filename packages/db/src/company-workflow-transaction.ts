import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { PostgresJsDatabase, PostgresJsTransaction } from "drizzle-orm/postgres-js";
import type { Db } from "./client.js";
import { companies } from "./schema/companies.js";

type WorkflowTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** DB-only helpers must reuse this handle, never cast it into a root Db. */
export type CompanyWorkflowDb = Omit<WorkflowTransaction, "transaction" | "setTransaction">;

export type CompanyWorkflowPurpose = "configuration_write" | "runtime_decision" | "publication_decision";

declare const contextBrand: unique symbol;

export interface CompanyWorkflowContext {
  readonly [contextBrand]: true;
  readonly companyId: string;
  readonly purpose: CompanyWorkflowPurpose;
}

export type CompanyWorkflowErrorCode = "invalid_company_id" | "invalid_purpose" | "root_database_required"
  | "nested_workflow_root" | "transaction_required" | "company_not_found" | "invalid_context"
  | "closed_context" | "wrong_async_scope" | "company_scope_mismatch" | "purpose_upgrade";

/** A DB package error; service callers own HTTP mapping and activity publication. */
export class CompanyWorkflowError extends Error {
  constructor(readonly code: CompanyWorkflowErrorCode) {
    super(`Company workflow transaction: ${code}`);
    this.name = "CompanyWorkflowError";
  }
}

interface Policy {
  companyLock: "key share" | "no key update";
  barrier: "shared" | "exclusive";
}

type RootScope = object;

interface ContextState {
  tx: WorkflowTransaction | null;
  scope: RootScope;
  companyId: string;
  purpose: CompanyWorkflowPurpose;
  active: boolean;
}

const rootScopes = new AsyncLocalStorage<RootScope>();
const contextStates = new WeakMap<CompanyWorkflowContext, ContextState>();
// PCWF: reserved two-int32 advisory namespace. Existing one-bigint locks use
// PostgreSQL's separate key space. Hash collisions only add contention; every
// SQL operation must still filter by the actual company UUID.
const WORKFLOW_ADVISORY_NAMESPACE = 0x50435746;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function companyScope(value: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new CompanyWorkflowError("invalid_company_id");
  return value.toLowerCase();
}

function policyFor(purpose: CompanyWorkflowPurpose): Policy {
  switch (purpose) {
    case "configuration_write": return { companyLock: "no key update", barrier: "exclusive" };
    case "runtime_decision": return { companyLock: "key share", barrier: "shared" };
    case "publication_decision": return { companyLock: "no key update", barrier: "shared" };
    default: throw new CompanyWorkflowError("invalid_purpose");
  }
}

function companyLockKey(companyId: string): number {
  return createHash("sha256").update("paperclip:company-workflow:v1\0").update(companyId, "utf8").digest().readInt32BE(0);
}

// Boolean checks preserve Db's complete schema generics. Narrowing directly to
// the runtime driver's class would replace them with its default `any` schema.
function isRootDatabase(value: unknown): boolean {
  return value instanceof PostgresJsDatabase && !(value instanceof PgTransaction);
}

function isPostgresTransaction(value: unknown): boolean {
  return value instanceof PostgresJsTransaction;
}

/**
 * Root entry for trusted, short DB-only work. No native business path currently
 * calls this foundation. It provides neither all-writer coverage nor admission.
 *
 * Company lock precedes the transaction-level workflow barrier. Runtime work
 * must not upgrade Company locks or enter accounting; KEY SHARE stabilizes the
 * company identity, not status/budget/permissions. All dependencies are reread
 * after the barrier, in the same READ COMMITTED transaction.
 *
 * Await every operation. No savepoints, root service calls, detached work,
 * filesystem/network/model work, or commit retries inside the callback. Publish
 * notifications only after this promise resolves. These are trusted-caller
 * obligations: this module cannot intercept arbitrary SQL or escaped handles.
 */
export async function withCompanyWorkflowTransaction<T>(
  db: Db,
  companyId: string,
  purpose: CompanyWorkflowPurpose,
  work: (context: CompanyWorkflowContext) => Promise<T>,
): Promise<T> {
  const scopeCompanyId = companyScope(companyId);
  const policy = policyFor(purpose);
  if (!isRootDatabase(db)) {
    throw new CompanyWorkflowError("root_database_required");
  }
  if (rootScopes.getStore()) throw new CompanyWorkflowError("nested_workflow_root");
  const scope: RootScope = {};
  return rootScopes.run(scope, () => db.transaction(async (tx) => {
    if (!isPostgresTransaction(tx)) throw new CompanyWorkflowError("transaction_required");
    const [company] = await tx.select({ id: companies.id }).from(companies)
      .where(eq(companies.id, scopeCompanyId)).for(policy.companyLock);
    if (!company) throw new CompanyWorkflowError("company_not_found");
    const key = companyLockKey(scopeCompanyId);
    if (policy.barrier === "exclusive") {
      await tx.execute(sql`select pg_advisory_xact_lock(${WORKFLOW_ADVISORY_NAMESPACE}::integer, ${key}::integer)`);
    } else {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(${WORKFLOW_ADVISORY_NAMESPACE}::integer, ${key}::integer)`);
    }
    const context = Object.freeze({ companyId: scopeCompanyId, purpose }) as CompanyWorkflowContext;
    const state: ContextState = { tx, scope, companyId: scopeCompanyId, purpose, active: true };
    contextStates.set(context, state);
    try {
      return await work(context);
    } finally {
      // The capability expires before commit/rollback. Escaped raw DB handles
      // remain a caller bug; expiry prevents obtaining a new handle via context.
      state.active = false;
      state.tx = null;
    }
  }, { isolationLevel: "read committed", accessMode: "read write", deferrable: false }));
}

/** Validate a required capability without acquiring another lock/transaction. */
export function companyWorkflowDb(
  context: CompanyWorkflowContext,
  requirement: { companyId: string; purpose: CompanyWorkflowPurpose },
): CompanyWorkflowDb {
  const state = contextStates.get(context);
  if (!state) throw new CompanyWorkflowError("invalid_context");
  if (!state.active || !state.tx) throw new CompanyWorkflowError("closed_context");
  if (rootScopes.getStore() !== state.scope) throw new CompanyWorkflowError("wrong_async_scope");
  if (companyScope(requirement.companyId) !== state.companyId) throw new CompanyWorkflowError("company_scope_mismatch");
  const needed = policyFor(requirement.purpose);
  const held = policyFor(state.purpose);
  if ((needed.barrier === "exclusive" && held.barrier !== "exclusive")
      || (needed.companyLock === "no key update" && held.companyLock !== "no key update")) {
    throw new CompanyWorkflowError("purpose_upgrade");
  }
  return state.tx;
}
