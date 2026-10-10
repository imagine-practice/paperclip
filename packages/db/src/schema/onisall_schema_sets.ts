import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Deployment-owned rules, not customer/Project documents or execution grants.
export const onisallSchemaVersions = pgTable("onisall_schema_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  registryKey: text("registry_key").notNull(), revision: text("revision").notNull(),
  sha256: text("sha256").notNull(), byteSize: integer("byte_size").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  identityUq: unique("onisall_schema_versions_identity_uq").on(t.companyId, t.registryKey, t.revision),
  scopeUq: unique("onisall_schema_versions_scope_uq").on(t.companyId, t.id),
  shape: check("onisall_schema_versions_shape", sql`length(${t.registryKey}) BETWEEN 1 AND 200
    AND length(${t.revision}) BETWEEN 1 AND 160 AND ${t.revision} NOT IN ('latest','main','master','HEAD')
    AND ${t.sha256} ~ '^[0-9a-f]{64}$' AND ${t.byteSize} BETWEEN 1 AND 1048576
    AND octet_length(${t.content}) = ${t.byteSize}`),
}));

export const onisallFrozenSchemaSets = pgTable("onisall_frozen_schema_sets", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  manifest: text("manifest").notNull(), manifestSha256: text("manifest_sha256").notNull(),
  schemaCount: integer("schema_count").notNull(), totalByteSize: integer("total_byte_size").notNull(),
  purpose: text("purpose").notNull().default("preparation"),
  executionAdmission: text("execution_admission").notNull().default("not_granted"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  manifestUq: unique("onisall_frozen_schema_sets_manifest_uq").on(t.companyId, t.manifestSha256),
  scopeUq: unique("onisall_frozen_schema_sets_scope_uq").on(t.companyId, t.id),
  shape: check("onisall_frozen_schema_sets_shape", sql`${t.purpose} = 'preparation' AND ${t.executionAdmission} = 'not_granted'
    AND ${t.schemaCount} BETWEEN 1 AND 64 AND ${t.totalByteSize} BETWEEN 1 AND 8388608
    AND ${t.manifestSha256} ~ '^[0-9a-f]{64}$' AND octet_length(${t.manifest}) BETWEEN 1 AND 131072`),
}));

export const onisallFrozenSchemaSetMembers = pgTable("onisall_frozen_schema_set_members", {
  companyId: uuid("company_id").notNull(), setId: uuid("set_id").notNull(),
  schemaId: uuid("schema_id").notNull(), position: integer("position").notNull(),
}, t => ({
  positionUq: unique("onisall_frozen_schema_members_position_uq").on(t.companyId, t.setId, t.position),
  schemaUq: unique("onisall_frozen_schema_members_schema_uq").on(t.companyId, t.setId, t.schemaId),
  setFk: foreignKey({ name: "onisall_frozen_schema_members_set_fk", columns: [t.companyId, t.setId],
    foreignColumns: [onisallFrozenSchemaSets.companyId, onisallFrozenSchemaSets.id] }),
  schemaFk: foreignKey({ name: "onisall_frozen_schema_members_schema_fk", columns: [t.companyId, t.schemaId],
    foreignColumns: [onisallSchemaVersions.companyId, onisallSchemaVersions.id] }),
  positionCheck: check("onisall_frozen_schema_members_position", sql`${t.position} BETWEEN 0 AND 63`),
}));
