export interface OnisallContractPreparation {
  protocol: "onisall.contract-preparation.v1"; id: string; companyId: string; intakeId: string;
  baselineId: string; ruleSetId: string; contractId: string; contractRevision: 1;
  candidateSha256: string; candidateByteSize: number; dependenciesSha256: string;
  acceptanceCriteriaHash: string; checkPlanSha256: string; preflightSha256: string;
  purpose: "preparation"; executionAdmission: "not_granted"; createdAt: string;
}
export type OnisallContractPreparationChange = "company_inactive" | "input_changed" | "binding_changed" |
  "case_head_changed" | "workflow_changed" | "native_blocked" | "native_pending" | "compiler_profile_changed";
export interface OnisallContractPreparationStatus {
  protocol: "onisall.contract-preparation-status.v1"; evaluatedAt: string; diagnosticsOnly: true;
  integrity: "verified"; preparation: OnisallContractPreparation;
  current: { status: "matches" | "changed"; changes: OnisallContractPreparationChange[] };
  preflight: { status: "verified" | "profile_changed"; maximumChecks: number; artifactKinds: string[] };
  publication: { status: "unavailable"; executionAdmission: "not_granted" };
  qualification: { sandbox: "not_evaluated"; businessAcceptance: "not_evaluated"; independentReview: "not_evaluated" };
}
export interface OnisallContractPreparationCatalog {
  protocol: "onisall.contract-preparation-catalog.v1"; companyId: string; intakeId: string; evaluatedAt: string;
  preparations: OnisallContractPreparation[]; nextOffset: number | null;
}
