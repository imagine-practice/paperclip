import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, boolean, timestamp, unique, uniqueIndex, index, foreignKey, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const onisallInputSnapshots = pgTable("onisall_input_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  protocol: text("protocol").notNull(),
  sha256: text("sha256").notNull(),
  byteSize: integer("byte_size").notNull(),
  lineCount: integer("line_count").notNull(),
  hasBom: boolean("has_bom").notNull(),
  provider: text("provider").notNull(),
  objectKey: text("object_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companyIdUq: unique("onisall_input_snapshots_company_id_uq").on(t.companyId, t.id),
  contentUq: uniqueIndex("onisall_input_snapshots_content_uq").on(t.companyId, t.sha256),
  objectUq: uniqueIndex("onisall_input_snapshots_object_uq").on(t.companyId, t.objectKey),
  shape: check("onisall_input_snapshots_shape", sql`${t.protocol} = 'onisall.input-text.v1' AND ${t.sha256} ~ '^[0-9a-f]{64}$' AND ${t.byteSize} BETWEEN 1 AND 1048576 AND ${t.lineCount} BETWEEN 1 AND 10000`),
}));

export const onisallIntakeDrafts = pgTable("onisall_intake_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  businessKey: text("business_key").notNull(),
  requestHash: text("request_hash").notNull(),
  goal: text("goal").notNull(),
  sourceLabel: text("source_label").notNull(),
  initialSnapshotId: uuid("initial_snapshot_id").notNull(),
  status: text("status").notNull().default("draft"),
  bindingStatus: text("binding_status").notNull().default("binding_pending"),
  controlMode: text("control_mode").notNull().default("native_pipeline"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companyIdUq: unique("onisall_intake_drafts_company_id_uq").on(t.companyId, t.id),
  businessUq: uniqueIndex("onisall_intake_drafts_business_uq").on(t.companyId, t.businessKey),
  snapshotFk: foreignKey({ name: "onisall_intake_drafts_snapshot_fk", columns: [t.companyId, t.initialSnapshotId],
    foreignColumns: [onisallInputSnapshots.companyId, onisallInputSnapshots.id] }),
  draftOnly: check("onisall_intake_drafts_draft_only", sql`${t.status} = 'draft' AND ${t.bindingStatus} = 'binding_pending' AND ${t.controlMode} = 'native_pipeline'`),
}));

export const onisallInputObservations = pgTable("onisall_input_observations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  intakeId: uuid("intake_id").notNull(),
  snapshotId: uuid("snapshot_id").notNull(),
  requestKey: text("request_key").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  observedByUserId: text("observed_by_user_id").notNull(),
}, (t) => ({
  requestUq: uniqueIndex("onisall_input_observations_request_uq").on(t.companyId, t.intakeId, t.requestKey),
  historyIdx: index("onisall_input_observations_history_idx").on(t.companyId, t.intakeId, t.observedAt, t.id),
  intakeFk: foreignKey({ name: "onisall_input_observations_intake_fk", columns: [t.companyId, t.intakeId],
    foreignColumns: [onisallIntakeDrafts.companyId, onisallIntakeDrafts.id] }),
  snapshotFk: foreignKey({ name: "onisall_input_observations_snapshot_fk", columns: [t.companyId, t.snapshotId],
    foreignColumns: [onisallInputSnapshots.companyId, onisallInputSnapshots.id] }),
}));
