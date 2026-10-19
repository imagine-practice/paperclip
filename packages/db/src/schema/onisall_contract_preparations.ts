import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { onisallIntakeDrafts } from "./onisall_intakes.js";
import { onisallPreparationBaselines } from "./onisall_preparation_baselines.js";
import { onisallFrozenRuleSets } from "./onisall_rule_sets.js";

// Immutable preparation history. These rows are never executable contracts.
export const onisallContractPreparations = pgTable("onisall_contract_preparations", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: uuid("company_id").notNull().references(() => companies.id),
  intakeId: uuid("intake_id").notNull(), baselineId: uuid("baseline_id").notNull(), ruleSetId: uuid("rule_set_id").notNull(),
  contractId: uuid("contract_id").notNull(), contractRevision: integer("contract_revision").notNull().default(1),
  requestKey: text("request_key").notNull(), requestPayload: text("request_payload").notNull(), requestHash: text("request_hash").notNull(),
  candidate: text("candidate").notNull(), candidateSha256: text("candidate_sha256").notNull(), candidateByteSize: integer("candidate_byte_size").notNull(),
  dependencies: text("dependencies").notNull(), dependenciesSha256: text("dependencies_sha256").notNull(),
  preflight: text("preflight").notNull(), preflightSha256: text("preflight_sha256").notNull(),
  checkPlan: text("check_plan").notNull(),
  acceptanceCriteriaHash: text("acceptance_criteria_hash").notNull(), checkPlanSha256: text("check_plan_sha256").notNull(),
  purpose: text("purpose").notNull().default("preparation"), executionAdmission: text("execution_admission").notNull().default("not_granted"),
  createdByUserId: text("created_by_user_id").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  requestUq: unique("onisall_contract_preparations_request_uq").on(t.companyId, t.intakeId, t.requestKey),
  identityUq: unique("onisall_contract_preparations_identity_uq").on(t.companyId, t.contractId, t.contractRevision),
  intakeFk: foreignKey({ name: "onisall_contract_preparations_intake_fk", columns: [t.companyId, t.intakeId],
    foreignColumns: [onisallIntakeDrafts.companyId, onisallIntakeDrafts.id] }),
  baselineFk: foreignKey({ name: "onisall_contract_preparations_baseline_fk", columns: [t.companyId, t.intakeId, t.baselineId],
    foreignColumns: [onisallPreparationBaselines.companyId, onisallPreparationBaselines.intakeId, onisallPreparationBaselines.id] }),
  ruleFk: foreignKey({ name: "onisall_contract_preparations_rule_fk", columns: [t.companyId, t.ruleSetId],
    foreignColumns: [onisallFrozenRuleSets.companyId, onisallFrozenRuleSets.id] }),
  shape: check("onisall_contract_preparations_shape", sql`${t.purpose} = 'preparation' AND ${t.executionAdmission} = 'not_granted'
    AND ${t.contractRevision} = 1 AND ${t.requestKey} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND ${t.candidateByteSize} BETWEEN 1 AND 1048576 AND octet_length(${t.candidate}) = ${t.candidateByteSize}
    AND octet_length(${t.requestPayload}) BETWEEN 1 AND 1048576 AND octet_length(${t.dependencies}) BETWEEN 1 AND 65536
    AND octet_length(${t.preflight}) BETWEEN 1 AND 1048576 AND octet_length(${t.checkPlan}) BETWEEN 1 AND 1048576 AND ${t.requestHash} ~ '^[a-f0-9]{64}$'
    AND ${t.candidateSha256} ~ '^[a-f0-9]{64}$' AND ${t.dependenciesSha256} ~ '^[a-f0-9]{64}$'
    AND ${t.preflightSha256} ~ '^[a-f0-9]{64}$' AND ${t.acceptanceCriteriaHash} ~ '^[a-f0-9]{64}$'
    AND ${t.checkPlanSha256} ~ '^[a-f0-9]{64}$'`),
}));
