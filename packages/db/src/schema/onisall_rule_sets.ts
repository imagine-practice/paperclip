import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { onisallFrozenSchemaSets } from "./onisall_schema_sets.js";

// Deployment-owned byte assets. Metadata is not an execution or publication grant.
export const onisallRuleVersions = pgTable("onisall_rule_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  kind: text("kind").notNull(), registryKey: text("registry_key").notNull(), revision: text("revision").notNull(),
  sha256: text("sha256").notNull(), byteSize: integer("byte_size").notNull(),
  descriptor: text("descriptor"), provider: text("provider").notNull(), objectKey: text("object_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  identityUq: unique("onisall_rule_versions_identity_uq").on(t.companyId, t.kind, t.registryKey, t.revision),
  scopeUq: unique("onisall_rule_versions_scope_uq").on(t.companyId, t.id),
  shape: check("onisall_rule_versions_shape", sql`${t.kind} IN ('check','command','runtime','policy')
    AND length(${t.registryKey}) BETWEEN 1 AND 200 AND length(${t.revision}) BETWEEN 1 AND 160
    AND ${t.revision} NOT IN ('latest','main','master','HEAD') AND ${t.sha256} ~ '^[0-9a-f]{64}$'
    AND ${t.byteSize} BETWEEN 1 AND 268435456
    AND (${t.kind} = 'runtime' OR (${t.kind} = 'check' AND ${t.byteSize} <= 1048576)
      OR (${t.kind} IN ('command','policy') AND ${t.byteSize} <= 65536))
    AND ((${t.kind} = 'check' AND ${t.descriptor} IS NOT NULL AND octet_length(${t.descriptor}) BETWEEN 1 AND 4096)
      OR (${t.kind} <> 'check' AND ${t.descriptor} IS NULL))
    AND ${t.provider} IN ('local_disk','s3') AND ${t.objectKey} LIKE ${t.companyId}::text || '/onisall-rules/v1/%'`),
}));

export const onisallFrozenRuleSets = pgTable("onisall_frozen_rule_sets", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  schemaSetId: uuid("schema_set_id").notNull(),
  manifest: text("manifest").notNull(), manifestSha256: text("manifest_sha256").notNull(),
  assetCount: integer("asset_count").notNull(), totalByteSize: integer("total_byte_size").notNull(),
  purpose: text("purpose").notNull().default("preparation"),
  executionAdmission: text("execution_admission").notNull().default("not_granted"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  manifestUq: unique("onisall_frozen_rule_sets_manifest_uq").on(t.companyId, t.manifestSha256),
  scopeUq: unique("onisall_frozen_rule_sets_scope_uq").on(t.companyId, t.id),
  schemaFk: foreignKey({ name: "onisall_frozen_rule_sets_schema_fk", columns: [t.companyId, t.schemaSetId],
    foreignColumns: [onisallFrozenSchemaSets.companyId, onisallFrozenSchemaSets.id] }),
  shape: check("onisall_frozen_rule_sets_shape", sql`${t.purpose} = 'preparation' AND ${t.executionAdmission} = 'not_granted'
    AND ${t.assetCount} BETWEEN 4 AND 256 AND ${t.totalByteSize} BETWEEN 4 AND 268435456
    AND ${t.manifestSha256} ~ '^[0-9a-f]{64}$' AND octet_length(${t.manifest}) BETWEEN 1 AND 262144`),
}));

export const onisallFrozenRuleSetMembers = pgTable("onisall_frozen_rule_set_members", {
  companyId: uuid("company_id").notNull(), setId: uuid("set_id").notNull(),
  ruleId: uuid("rule_id").notNull(), position: integer("position").notNull(),
}, t => ({
  positionUq: unique("onisall_frozen_rule_members_position_uq").on(t.companyId, t.setId, t.position),
  ruleUq: unique("onisall_frozen_rule_members_rule_uq").on(t.companyId, t.setId, t.ruleId),
  setFk: foreignKey({ name: "onisall_frozen_rule_members_set_fk", columns: [t.companyId, t.setId],
    foreignColumns: [onisallFrozenRuleSets.companyId, onisallFrozenRuleSets.id] }),
  ruleFk: foreignKey({ name: "onisall_frozen_rule_members_rule_fk", columns: [t.companyId, t.ruleId],
    foreignColumns: [onisallRuleVersions.companyId, onisallRuleVersions.id] }),
  positionCheck: check("onisall_frozen_rule_members_position", sql`${t.position} BETWEEN 0 AND 255`),
}));
