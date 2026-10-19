import { describe, expect, it } from "vitest";
import {
  assertForkMigrationFallbackSafe,
  normalizeRenamedMigrationHistory,
  RENAMED_FORK_MIGRATIONS,
  validateRenamedMigrationSource,
} from "./migration-history-aliases.js";

const availableMigrations = RENAMED_FORK_MIGRATIONS.map((entry) => entry.newName);
const fileHashes = new Map(RENAMED_FORK_MIGRATIONS.map((entry) => [entry.newName, entry.sha256]));
const options = { hasHashColumn: true, availableMigrations, fileHashes };
const HISTORY_ERROR = "Renamed fork migration history is ambiguous or incompatible.";
const FALLBACK_ERROR = "Migration history fallback cannot identify the merged fork branch.";

describe("normalizeRenamedMigrationHistory", () => {
  it("recognizes every exact published old name against its published hash", () => {
    expect(normalizeRenamedMigrationHistory(
      RENAMED_FORK_MIGRATIONS.flatMap((entry) =>
        entry.previousNames.map((name) => ({ name, hash: entry.sha256 })),
      ),
      options,
    )).toEqual(availableMigrations);
  });

  it("recognizes canonical names and deduplicates mixed old/new rows in stable order", () => {
    const [first, second] = RENAMED_FORK_MIGRATIONS;
    expect(normalizeRenamedMigrationHistory([
      { name: second.newName, hash: second.sha256 },
      { name: first.previousNames[0], hash: first.sha256 },
      { name: second.previousNames[1], hash: second.sha256 },
      { name: first.newName, hash: first.sha256 },
    ], options)).toEqual([second.newName, first.newName]);
  });

  it("supports exact legacy names without a hash column but still validates source", () => {
    expect(normalizeRenamedMigrationHistory(
      RENAMED_FORK_MIGRATIONS.flatMap((entry) => entry.previousNames.map((name) => ({ name }))),
      { ...options, hasHashColumn: false },
    )).toEqual(availableMigrations);
  });

  it.each([undefined, null, "", "wrong-persisted-hash"])("rejects absent or contradictory hash evidence: %s", (hash) => {
    for (const entry of RENAMED_FORK_MIGRATIONS) {
      for (const name of [...entry.previousNames, entry.newName]) {
        expect(() => normalizeRenamedMigrationHistory([{ name, hash }], options)).toThrow(HISTORY_ERROR);
      }
    }
  });

  it("does not let a valid duplicate conceal a conflicting historical row", () => {
    const first = RENAMED_FORK_MIGRATIONS[0];
    expect(() => normalizeRenamedMigrationHistory([
      { name: first.newName, hash: first.sha256 },
      { name: first.previousNames[0], hash: RENAMED_FORK_MIGRATIONS[1].sha256 },
    ], options)).toThrow(HISTORY_ERROR);
  });

  it("rejects missing or duplicate canonical destinations", () => {
    const first = RENAMED_FORK_MIGRATIONS[0];
    for (const destinations of [
      availableMigrations.slice(1),
      [...availableMigrations, first.newName],
      [...availableMigrations, first.previousNames[0]],
    ]) {
      expect(() => normalizeRenamedMigrationHistory(
        [{ name: first.previousNames[0], hash: first.sha256 }],
        { ...options, availableMigrations: destinations },
      )).toThrow(HISTORY_ERROR);
    }
  });

  it("rejects missing or altered published source even for name-only ledgers", () => {
    const first = RENAMED_FORK_MIGRATIONS[0];
    for (const hashes of [new Map<string, string>(), new Map([[first.newName, "altered-source"]])]) {
      expect(() => normalizeRenamedMigrationHistory(
        [{ name: first.previousNames[0] }],
        { ...options, hasHashColumn: false, fileHashes: hashes },
      )).toThrow(HISTORY_ERROR);
    }
  });

  it("preserves upstream names sharing the old numeric prefixes and ignores nameless rows", () => {
    const upstream = ["0320_daily_onslaught.sql", "0321_acoustic_human_fly.sql", "0322_reflective_kree.sql", "0323_petite_shockwave.sql"];
    expect(normalizeRenamedMigrationHistory([
      ...upstream.map((name) => ({ name, hash: "unrelated-upstream-hash" })),
      { name: null }, { name: "" }, {},
    ], options)).toEqual(upstream);
  });

  it("does not infer aliases from prefixes, suffixes, or old tags lacking the SQL extension", () => {
    const names = ["0320_other.sql", "9999_onisall_intake_drafts.sql", "0320_onisall_intake_drafts"];
    expect(normalizeRenamedMigrationHistory(names.map((name) => ({ name })), options)).toEqual(names);
  });

  it("never includes untrusted database values in its error", () => {
    const first = RENAMED_FORK_MIGRATIONS[0];
    expect(() => normalizeRenamedMigrationHistory([
      { name: first.previousNames[0], hash: "private-database-value" },
    ], options)).toThrow(new Error(HISTORY_ERROR));
  });
});

describe("validateRenamedMigrationSource", () => {
  it("accepts exactly published canonical source hashes", () => {
    for (const entry of RENAMED_FORK_MIGRATIONS) {
      expect(() => validateRenamedMigrationSource(entry.newName, entry.sha256)).not.toThrow();
      expect(() => validateRenamedMigrationSource(entry.newName, "altered")).toThrow(
        "Renamed fork migration source does not match its published identity.",
      );
    }
  });

  it("does not impose fork hashes on upstream migrations sharing old prefixes", () => {
    expect(() => validateRenamedMigrationSource("0320_daily_onslaught.sql", "upstream-hash")).not.toThrow();
  });
});

describe("assertForkMigrationFallbackSafe", () => {
  it("allows the exact common-prefix boundary", () => {
    expect(() => assertForkMigrationFallbackSafe(availableMigrations, ["0319_legacy.sql"], {
      rowCount: 318, ids: [1, 318], lastCreatedAt: 1791497222456,
    })).not.toThrow();
  });

  it("allows empty common history", () => {
    expect(() => assertForkMigrationFallbackSafe(availableMigrations, [], {
      rowCount: 0, ids: [], lastCreatedAt: -1,
    })).not.toThrow();
  });

  it.each([
    { rowCount: 319 },
    { rowCount: 1, ids: [319] },
    { rowCount: 1, lastCreatedAt: 1791497222457 },
    { rowCount: 1, lastCreatedAt: 1791606793730 },
  ])("rejects divergent positional or timestamp evidence: %j", (history) => {
    expect(() => assertForkMigrationFallbackSafe(availableMigrations, [], history)).toThrow(FALLBACK_ERROR);
  });

  it.each(["0320_daily_onslaught.sql", "0320_onisall_intake_drafts.sql", "0347_onisall_intake_drafts.sql", "0350_onisall_schema_sets.sql", "0355_onisall_intake_drafts.sql"])(
    "rejects a divergent candidate even with a short history: %s", (name) => {
      expect(() => assertForkMigrationFallbackSafe(availableMigrations, [name], { rowCount: 1 })).toThrow(FALLBACK_ERROR);
    },
  );

  it("activates the boundary when even one canonical fork target is available", () => {
    expect(() => assertForkMigrationFallbackSafe([availableMigrations[0]], [], { rowCount: 319 })).toThrow(FALLBACK_ERROR);
  });

  it.each([
    { rowCount: -1 }, { rowCount: 1.5 }, { rowCount: Number.NaN },
    { rowCount: 1, ids: [0] }, { rowCount: 1, ids: [Number.NaN] },
    { rowCount: 1, lastCreatedAt: Number.POSITIVE_INFINITY },
  ])("rejects malformed merged fallback metadata: %j", (history) => {
    expect(() => assertForkMigrationFallbackSafe(availableMigrations, [], history)).toThrow(FALLBACK_ERROR);
  });

  it("leaves an unmerged legacy migration set unchanged", () => {
    expect(() => assertForkMigrationFallbackSafe(["0320_daily_onslaught.sql"], ["0320_daily_onslaught.sql"], {
      rowCount: 400, ids: [400], lastCreatedAt: 1791606793730,
    })).not.toThrow();
  });
});
