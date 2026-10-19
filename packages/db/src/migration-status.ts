import { closedStartupMigrationError, coreMigrationMode, requireMigrationInspectionPayload } from "./startup-migration-policy.js";
import { inspectMigrations } from "./client.js";
import { resolveMigrationConnection } from "./migration-runtime.js";

const jsonMode = process.argv.includes("--json");

function toError(error: unknown, context = "Migration status check failed"): Error {
  if (error instanceof Error) return error;
  if (error === undefined) return new Error(context);
  if (typeof error === "string") return new Error(`${context}: ${error}`);

  try {
    return new Error(`${context}: ${JSON.stringify(error)}`);
  } catch {
    return new Error(`${context}: ${String(error)}`);
  }
}

async function main(): Promise<void> {
  const connection = await resolveMigrationConnection();

  try {
    const state = await inspectMigrations(connection.connectionString);
    const payload =
      state.status === "upToDate"
        ? {
            source: connection.source,
            status: "upToDate" as const,
            tableCount: state.tableCount,
            pendingMigrations: [] as string[],
          }
        : {
            source: connection.source,
            status: "needsMigrations" as const,
            tableCount: state.tableCount,
            pendingMigrations: state.pendingMigrations,
            reason: state.reason,
          };

    const observed = coreMigrationMode === "inspect_only"
      ? requireMigrationInspectionPayload({ ...payload, migrationMode: "inspect_only",
        proofLevel: "migration_history_only", executionEligibility: "not_assessed" }) : payload;
    if (jsonMode) {
      console.log(JSON.stringify(observed));
      return;
    }

    if (payload.status === "upToDate") {
      console.log(`Database is up to date via ${payload.source}`);
      return;
    }

    console.log(
      `Pending migrations via ${payload.source}: ${payload.pendingMigrations.join(", ")}`,
    );
  } finally {
    await connection.stop();
  }
}

main().catch((error) => {
  if (coreMigrationMode === "inspect_only") {
    process.stderr.write(`${closedStartupMigrationError(error, "inspection_failed").message}\n`);
    process.exit(1);
  }
  const err = toError(error, "Migration status check failed");
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});
