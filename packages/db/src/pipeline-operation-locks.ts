import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
// Dedicated two-int key spaces; distinct from workflow and one-bigint native locks.
const LIFECYCLE_NAMESPACE = 0x50434f4c;
const OPERATION_NAMESPACE = 0x50434f50;

function normalizedUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Operation lock requires a UUID");
  }
  return value.toLowerCase();
}

/** After Company KEY SHARE, before any downstream lock. Never block here. */
export async function tryPipelineOperationCompanyLifecycle(tx: Tx, companyId: string): Promise<boolean> {
  companyId = normalizedUuid(companyId);
  const [row] = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock_shared(${LIFECYCLE_NAMESPACE}::integer, hashtext(${companyId}::text)) as acquired`);
  return row?.acquired === true;
}

/** Company remove only: after its original NO KEY UPDATE, before child cleanup. */
export async function lockPipelineOperationCompanyLifecycle(tx: Tx, companyId: string): Promise<void> {
  companyId = normalizedUuid(companyId);
  await tx.execute(sql`select pg_advisory_xact_lock(${LIFECYCLE_NAMESPACE}::integer, hashtext(${companyId}::text))`);
}

/** One operation per root. Hash collisions only serialize; UUID uniqueness remains in DB. */
export async function lockPipelineOperationKey(tx: Tx, companyId: string, operationId: string): Promise<void> {
  companyId = normalizedUuid(companyId);
  operationId = normalizedUuid(operationId);
  await tx.execute(sql`select pg_advisory_xact_lock(${OPERATION_NAMESPACE}::integer, hashtext(${`${companyId}:${operationId}`}::text))`);
}
