/** Exact identities retained when the two migration branches are merged. */
export const RENAMED_FORK_MIGRATIONS = [
  {
    previousNames: ["0320_onisall_intake_drafts.sql", "0347_onisall_intake_drafts.sql"],
    newName: "0355_onisall_intake_drafts.sql",
    sha256: "50f9ec8bcacecd2ace4595617046ad8ea8c053cb2c4db18dd63f77c3302ce4ec",
  },
  {
    previousNames: ["0321_onisall_native_bindings.sql", "0348_onisall_native_bindings.sql"],
    newName: "0356_onisall_native_bindings.sql",
    sha256: "0a20074168c4d158b2d700fa02acd5ab01268ee4225d66aec97153a59a0b67a7",
  },
  {
    previousNames: ["0322_onisall_preparation_baselines.sql", "0349_onisall_preparation_baselines.sql"],
    newName: "0357_onisall_preparation_baselines.sql",
    sha256: "8d63b7d695f479b7e4f779c78406c848bed63c564ecd3b57cf0197825a17b3b2",
  },
  {
    previousNames: ["0323_onisall_schema_sets.sql", "0350_onisall_schema_sets.sql"],
    newName: "0358_onisall_schema_sets.sql",
    sha256: "d577349845aa0867715ad31949207278c914f2aa210bdc9e1fbff5d7b5a0739b",
  },
  {
    previousNames: ["0324_onisall_rule_sets.sql"],
    newName: "0359_onisall_rule_sets.sql",
    sha256: "e57fa5e114c2ed7b18b1c09fb07ff7b7ff5d1108303668f1dcdf9b0a6b0c48ca",
  },
  {
    previousNames: ["0325_onisall_contract_preparations.sql"],
    newName: "0360_onisall_contract_preparations.sql",
    sha256: "a6f798c71952b53276b99998609d30d0296ebb3940c018f8e76c4378c6e11f21",
  },
  {
    previousNames: ["0326_lethal_martin_li.sql"],
    newName: "0361_lethal_martin_li.sql",
    sha256: "7d4db7c5e1f6f8967fce491adf9872b17509a112c0e89c62bdf08fd9a9efeece",
  },
] as const;

const HISTORY_ERROR = "Renamed fork migration history is ambiguous or incompatible.";
const SOURCE_ERROR = "Renamed fork migration source does not match its published identity.";
const FALLBACK_ERROR = "Migration history fallback cannot identify the merged fork branch.";
const COMMON_HISTORY_ROW_COUNT = 318;
const FIRST_DIVERGENT_TIMESTAMP = 1791497222457;

export type NamedMigrationHistoryRow = {
  name?: string | null;
  hash?: string | null;
};

/** Validate published source before trusting it in either name or hash lookup. */
export function validateRenamedMigrationSource(fileName: string, hash: string): void {
  const migration = RENAMED_FORK_MIGRATIONS.find((entry) => entry.newName === fileName);
  if (migration && hash !== migration.sha256) throw new Error(SOURCE_ERROR);
}

export function normalizeRenamedMigrationHistory(
  rows: readonly NamedMigrationHistoryRow[],
  options: {
    hasHashColumn: boolean;
    availableMigrations: readonly string[];
    fileHashes: ReadonlyMap<string, string>;
  },
): string[] {
  const normalized = new Set<string>();
  for (const row of rows) {
    if (!row.name) continue;
    const migration = RENAMED_FORK_MIGRATIONS.find(
      (entry) => entry.previousNames.some((name) => name === row.name) || entry.newName === row.name,
    );
    if (!migration) {
      normalized.add(row.name);
      continue;
    }

    const targets = options.availableMigrations.filter((name) => name === migration.newName);
    if (
      targets.length !== 1
      || migration.previousNames.some((name) => options.availableMigrations.includes(name))
      || options.fileHashes.get(migration.newName) !== migration.sha256
    ) {
      throw new Error(HISTORY_ERROR);
    }
    // A present hash column is evidence, even when its stored value is empty.
    if (options.hasHashColumn && row.hash !== migration.sha256) throw new Error(HISTORY_ERROR);
    normalized.add(migration.newName);
  }
  return [...normalized];
}

/** Positional/timestamp history is usable only before the branches diverged. */
export function assertForkMigrationFallbackSafe(
  availableMigrations: readonly string[],
  candidateNames: readonly string[],
  history: { rowCount: number; ids?: readonly number[]; lastCreatedAt?: number },
): void {
  const hasMergedFork = RENAMED_FORK_MIGRATIONS.some((entry) => availableMigrations.includes(entry.newName));
  if (!hasMergedFork) return;

  if (
    !Number.isSafeInteger(history.rowCount)
    || history.rowCount < 0
    || history.rowCount > COMMON_HISTORY_ROW_COUNT
    || history.ids?.some((id) => !Number.isSafeInteger(id) || id < 1 || id > COMMON_HISTORY_ROW_COUNT)
    || (history.lastCreatedAt !== undefined && (
      !Number.isFinite(history.lastCreatedAt) || history.lastCreatedAt >= FIRST_DIVERGENT_TIMESTAMP
    ))
    || candidateNames.some((name) => {
      const prefix = /^(\d{4})_/.exec(name);
      return prefix !== null && Number(prefix[1]) >= 320;
    })
  ) {
    throw new Error(FALLBACK_ERROR);
  }
}
