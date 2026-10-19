import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { pipelineCases } from "./pipeline_cases.js";
import { onisallIntakeDrafts, onisallNativeBindings } from "./onisall_intakes.js";

/** Historical preparation observations; no mutable stage or admission head. */
export const onisallPreparationBaselines = pgTable("onisall_preparation_baselines", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  intakeId: uuid("intake_id").notNull(),
  bindingId: uuid("binding_id").notNull(),
  snapshotId: uuid("snapshot_id").notNull(),
  inputSha256: text("input_sha256").notNull(),
  pipelineId: uuid("pipeline_id").notNull(),
  projectId: uuid("project_id"),
  caseId: uuid("case_id").notNull(),
  caseVersion: integer("case_version").notNull(),
  stageId: uuid("stage_id").notNull(),
  stageKey: text("stage_key").notNull(),
  bindingRevision: integer("binding_revision").notNull(),
  bindingConfigurationHash: text("binding_configuration_hash").notNull(),
  workflowHash: text("workflow_hash").notNull(),
  workflowSnapshot: text("workflow_snapshot").notNull(),
  baselineHash: text("baseline_hash").notNull(),
  requestKey: text("request_key").notNull(),
  purpose: text("purpose").notNull().default("preparation"),
  executionAdmission: text("execution_admission").notNull().default("not_granted"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  scopeUq: unique("onisall_preparation_baselines_scope_uq").on(t.companyId, t.intakeId, t.id),
  requestUq: unique("onisall_preparation_baselines_request_uq").on(t.companyId, t.intakeId, t.requestKey),
  bindingFk: foreignKey({ name: "onisall_preparation_baselines_binding_fk", columns: [t.companyId, t.intakeId, t.bindingId],
    foreignColumns: [onisallNativeBindings.companyId, onisallNativeBindings.intakeId, onisallNativeBindings.id] }),
  intakeFk: foreignKey({ name: "onisall_preparation_baselines_intake_fk", columns: [t.companyId, t.intakeId, t.snapshotId],
    foreignColumns: [onisallIntakeDrafts.companyId, onisallIntakeDrafts.id, onisallIntakeDrafts.initialSnapshotId] }),
  caseFk: foreignKey({ name: "onisall_preparation_baselines_case_fk", columns: [t.companyId, t.pipelineId, t.caseId],
    foreignColumns: [pipelineCases.companyId, pipelineCases.pipelineId, pipelineCases.id] }),
  projectFk: foreignKey({ name: "onisall_preparation_baselines_project_fk", columns: [t.companyId, t.projectId],
    foreignColumns: [projects.companyId, projects.id] }),
  // stageId is a historical reference: deleting a stage must not delete its
  // frozen configuration or mutate the recorded observation.
  preparationOnly: check("onisall_preparation_baselines_shape", sql`${t.purpose} = 'preparation' AND ${t.executionAdmission} = 'not_granted'
    AND ${t.bindingRevision} = 1 AND ${t.caseVersion} > 0 AND length(${t.stageKey}) BETWEEN 1 AND 200
    AND ${t.requestKey} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND ${t.inputSha256} ~ '^[0-9a-f]{64}$' AND ${t.bindingConfigurationHash} ~ '^[0-9a-f]{64}$'
    AND ${t.workflowHash} ~ '^[0-9a-f]{64}$' AND ${t.baselineHash} ~ '^[0-9a-f]{64}$'
    AND octet_length(${t.workflowSnapshot}) BETWEEN 1 AND 1048576`),
}));
