import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, jsonb, uniqueIndex, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// No Case/event/ledger/principal FK: their deletion must never release an operation key.
export const pipelineOperationReceipts = pgTable("pipeline_operation_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  operationId: uuid("operation_id").notNull(),
  rootKind: text("root_kind").notNull().default("case_transition"),
  protocolVersion: integer("protocol_version").notNull().default(1),
  principalType: text("principal_type").notNull().default("user"),
  principalId: text("principal_id").notNull(),
  provenanceVersion: integer("provenance_version").notNull().default(1),
  requestCanonicalVersion: integer("request_canonical_version").notNull().default(1),
  requestFingerprint: text("request_fingerprint").notNull(),
  epoch: text("epoch"),
  epochProvenance: text("epoch_provenance").notNull().default("legacy_unversioned"),
  coverageKind: text("coverage_kind").notNull().default("limited_root_result_v1"),
  factsVersion: integer("facts_version").notNull().default(1),
  rootFacts: jsonb("root_facts").$type<Record<string, unknown>>(),
  rootFactsSha256: text("root_facts_sha256"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  retentionDisposition: text("retention_disposition").notNull().default("facts_preserved"),
  redactedAt: timestamp("redacted_at", { withTimezone: true }),
  retentionPolicyVersion: integer("retention_policy_version").notNull().default(1),
}, table => ({
  operationUnique: uniqueIndex("pipeline_operation_receipts_company_operation_uq").on(table.companyId, table.operationId),
  protocol: check("pipeline_operation_receipts_protocol_ck", sql`${table.rootKind} = 'case_transition' AND ${table.protocolVersion} = 1 AND ${table.principalType} = 'user' AND ${table.principalId} NOT IN ('board', 'local-board') AND length(${table.principalId}) > 0 AND ${table.provenanceVersion} = 1 AND ${table.requestCanonicalVersion} = 1 AND ${table.factsVersion} = 1 AND ${table.coverageKind} = 'limited_root_result_v1' AND ${table.epoch} IS NULL AND ${table.epochProvenance} = 'legacy_unversioned' AND ${table.retentionPolicyVersion} = 1`),
  fingerprint: check("pipeline_operation_receipts_fingerprint_ck", sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`),
  retention: check("pipeline_operation_receipts_retention_ck", sql`(${table.retentionDisposition} = 'facts_preserved' AND ${table.rootFacts} IS NOT NULL AND ${table.rootFactsSha256} IS NOT NULL AND ${table.rootFactsSha256} ~ '^[0-9a-f]{64}$' AND ${table.redactedAt} IS NULL) OR (${table.retentionDisposition} = 'tombstone' AND ${table.rootFacts} IS NULL AND ${table.rootFactsSha256} IS NULL AND ${table.redactedAt} IS NOT NULL)`),
}));
