/** Core migration controls, captured before dotenv/config/worktree bootstrap.
 * This does not constrain plugin SQL, business writes or all startup effects.
 */
export type CoreMigrationMode = "legacy" | "inspect_only";
const ERROR_CODES = [
  "policy_invalid", "policy_drift", "explicit_target_required", "target_mismatch",
  "write_forbidden", "inspection_failed", "inspection_payload_invalid",
  "migrations_pending", "startup_configuration_unavailable",
  "existing_runner_unverified",
] as const;
export type StartupMigrationErrorCode = (typeof ERROR_CODES)[number];

export class StartupMigrationPolicyError extends Error {
  readonly code: StartupMigrationErrorCode;
  constructor(code: StartupMigrationErrorCode) {
    const safeCode = ERROR_CODES.includes(code) ? code : "policy_invalid";
    super(`Core migration policy: ${safeCode}`);
    this.name = "StartupMigrationPolicyError";
    this.code = safeCode;
  }
}

function parseMode(value: string | undefined): CoreMigrationMode {
  if (value === undefined || value === "legacy") return "legacy";
  if (value === "inspect_only") return "inspect_only";
  throw new StartupMigrationPolicyError("policy_invalid");
}

function requireExplicitUrl(value: string | undefined): string {
  if (!value || value !== value.trim()) {
    throw new StartupMigrationPolicyError("explicit_target_required");
  }
  try {
    const parsed = new URL(value);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)
      || !parsed.hostname || parsed.pathname.length <= 1) throw new Error();
  } catch {
    throw new StartupMigrationPolicyError("explicit_target_required");
  }
  return value;
}

// Private immutable control snapshot. It is never serialized or logged.
const capturedMode = parseMode(process.env.PAPERCLIP_CORE_MIGRATION_MODE);
const capturedDatabaseUrl = capturedMode === "inspect_only"
  ? requireExplicitUrl(process.env.DATABASE_URL) : undefined;
const capturedMigrationUrl = capturedMode === "inspect_only"
  ? process.env.DATABASE_MIGRATION_URL : undefined;
if (capturedMode === "inspect_only" && capturedMigrationUrl !== undefined
  && capturedMigrationUrl !== capturedDatabaseUrl) {
  throw new StartupMigrationPolicyError("target_mismatch");
}

export const coreMigrationMode: CoreMigrationMode = capturedMode;

export function assertStartupMigrationEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  if (parseMode(env.PAPERCLIP_CORE_MIGRATION_MODE) !== capturedMode
    || (capturedMode === "inspect_only" && (env.DATABASE_URL !== capturedDatabaseUrl
      || env.DATABASE_MIGRATION_URL !== capturedMigrationUrl))) {
    throw new StartupMigrationPolicyError("policy_drift");
  }
}

export function startupMigrationChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  assertStartupMigrationEnvironment(env);
  const child: NodeJS.ProcessEnv = { ...env, PAPERCLIP_CORE_MIGRATION_MODE: capturedMode };
  if (capturedMode === "inspect_only") {
    child.DATABASE_URL = capturedDatabaseUrl;
    if (capturedMigrationUrl === undefined) delete child.DATABASE_MIGRATION_URL;
    else child.DATABASE_MIGRATION_URL = capturedMigrationUrl;
  }
  return child;
}

export function inspectOnlyMigrationConnection(): { connectionString: string; source: "explicit-process-postgres" } {
  assertStartupMigrationEnvironment();
  if (capturedMode !== "inspect_only" || capturedDatabaseUrl === undefined) {
    throw new StartupMigrationPolicyError("explicit_target_required");
  }
  return { connectionString: capturedDatabaseUrl, source: "explicit-process-postgres" };
}

export function assertMigrationInspectionConnection(url: string): void {
  assertStartupMigrationEnvironment();
  if (capturedMode === "inspect_only" && url !== capturedDatabaseUrl) {
    throw new StartupMigrationPolicyError("target_mismatch");
  }
}

export function assertMigrationWriteAllowed(): void {
  assertStartupMigrationEnvironment();
  if (capturedMode === "inspect_only") throw new StartupMigrationPolicyError("write_forbidden");
}

export function closedStartupMigrationError(error: unknown, fallback: StartupMigrationErrorCode): StartupMigrationPolicyError {
  return error instanceof StartupMigrationPolicyError
    ? new StartupMigrationPolicyError(error.code) : new StartupMigrationPolicyError(fallback);
}

export type MigrationInspectionPayload = {
  source: "explicit-process-postgres";
  migrationMode: "inspect_only";
  proofLevel: "migration_history_only";
  executionEligibility: "not_assessed";
  status: "upToDate" | "needsMigrations";
  tableCount: number;
  pendingMigrations: string[];
  reason?: "pending-migrations" | "no-migration-journal-empty-db" | "no-migration-journal-non-empty-db";
};

export function requireMigrationInspectionPayload(value: unknown): MigrationInspectionPayload {
  const fail = (): never => { throw new StartupMigrationPolicyError("inspection_payload_invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  const allowed = new Set(["source", "migrationMode", "proofLevel", "executionEligibility",
    "status", "tableCount", "pendingMigrations", ...(row.status === "needsMigrations" ? ["reason"] : [])]);
  if (Object.keys(row).length !== allowed.size || Object.keys(row).some((key) => !allowed.has(key))
    || row.source !== "explicit-process-postgres" || row.migrationMode !== "inspect_only"
    || row.proofLevel !== "migration_history_only" || row.executionEligibility !== "not_assessed"
    || (row.status !== "upToDate" && row.status !== "needsMigrations")
    || typeof row.tableCount !== "number" || !Number.isSafeInteger(row.tableCount) || row.tableCount < 0
    || !Array.isArray(row.pendingMigrations) || row.pendingMigrations.length > 1024
    || row.pendingMigrations.some((entry) => typeof entry !== "string" || !entry.length
      || entry.length > 256 || /[\x00-\x1f\x7f/\\]/.test(entry))) return fail();
  if (row.status === "upToDate" ? row.pendingMigrations.length !== 0
    : !row.pendingMigrations.length || !["pending-migrations", "no-migration-journal-empty-db",
      "no-migration-journal-non-empty-db"].includes(String(row.reason))) return fail();
  return row as MigrationInspectionPayload;
}
