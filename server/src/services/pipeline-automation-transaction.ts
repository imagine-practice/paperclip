import type { Db } from "@paperclipai/db";
import type { pipelineAutomationExecutions } from "@paperclipai/db";
import { is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { conflict } from "../errors.js";

type PipelineTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type AutomationLedger = typeof pipelineAutomationExecutions.$inferSelect;

/** Existing dispatching service entries own a root commit, never a savepoint. */
export function assertPipelineAutomationRoot(db: Db): void {
  if (is(db, PgTransaction)) {
    throw conflict("Pipeline automation dispatch requires the root database", {
      code: "root_database_required",
    });
  }
}

/** Trusted callbacks only. This collects references, without granting or dispatching work. */
export async function commitPipelineAutomationTransaction<Result>(
  db: Db,
  work: (tx: PipelineTransaction, automationLedgers: AutomationLedger[]) => Promise<Result>,
): Promise<{ result: Result; automationLedgers: readonly AutomationLedger[] }> {
  assertPipelineAutomationRoot(db);
  return db.transaction(async (tx) => {
    const automationLedgers: AutomationLedger[] = [];
    const result = await work(tx, automationLedgers);
    // Capture completed transaction work; do not retain its mutable collector array.
    return { result, automationLedgers: [...automationLedgers] };
  });
}

/** Call only after the owning root commit. No catch, retry, or historical pending scan. */
export async function dispatchPipelineAutomationLedgers<Result>(
  automationLedgers: readonly AutomationLedger[],
  execute: (executionId: string) => Promise<Result>,
): Promise<Map<string, Result>> {
  const results = new Map<string, Result>();
  for (const ledger of automationLedgers) {
    if (results.has(ledger.id)) continue;
    results.set(ledger.id, await execute(ledger.id));
  }
  return results;
}
