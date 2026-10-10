import { z } from "zod";

/** Read-only observations, never a publication decision or execution credential. */
export interface OnisallPreparationStatus {
  protocol: "onisall.intake-preparation-status.v1";
  evaluatedAt: string;
  companyId: string;
  intakeId: string;
  diagnosticsOnly: true;
  input: {
    status: "verified";
    snapshotId: string;
    sha256: string;
    byteSize: number;
    lineCount: number;
  };
  nativeBinding: { status: "pending" } | {
    status: "recorded";
    bindingId: string;
    caseId: string;
    revision: 1;
  };
  publication: { status: "unavailable"; reason: "publication_not_implemented"; executionAdmission: "not_granted" };
  remainingChecks: Array<{
    code: "native_current_head" | "contract_preflight" | "checks_and_independent_review"
      | "human_decisions" | "execution_qualification" | "budget_and_permissions";
    status: "not_evaluated";
  }>;
}

// Draft transport v2 is deliberately separate from published TaskContract v3.
export const ONISALL_INTAKE_DRAFT_VERSION = 2 as const;
export const ONISALL_INPUT_MAX_BYTES = 1024 * 1024;
const requestKey = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const contentBase64 = z.string().min(4).max(4 * Math.ceil(ONISALL_INPUT_MAX_BYTES / 3))
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);
export const createOnisallIntakeDraftSchema = z.object({
  requestKey,
  goal: z.string().trim().min(1).max(4000),
  sourceLabel: z.string().trim().min(1).max(200),
  contentBase64,
}).strict();
export const observeOnisallInputSchema = z.object({ requestKey, contentBase64 }).strict();
export type CreateOnisallIntakeDraft = z.infer<typeof createOnisallIntakeDraftSchema>;
export type ObserveOnisallInput = z.infer<typeof observeOnisallInputSchema>;

export interface OnisallInputSnapshot {
  id: string;
  companyId: string;
  protocol: "onisall.input-text.v1";
  sha256: string;
  byteSize: number;
  lineCount: number;
  hasBom: boolean;
  createdAt: string;
}
export interface OnisallInputObservation {
  id: string;
  companyId: string;
  intakeId: string;
  snapshotId: string;
  requestKey: string;
  observedAt: string;
  observedByUserId: string;
}
export interface OnisallIntakeDraft {
  kind: "intake_draft";
  draftVersion: 2;
  id: string;
  companyId: string;
  businessKey: string;
  goal: string;
  sourceLabel: string;
  status: "draft";
  bindingStatus: "binding_pending" | "bound";
  controlMode: "native_pipeline";
  // No placeholder IDs or implied published authority.
  clientId: null;
  projectId: string | null;
  caseId: string | null;
  binding: OnisallNativeBinding | null;
  contractId: null;
  initialSnapshot: OnisallInputSnapshot;
  createdAt: string;
}
export interface OnisallObservationPage {
  observations: OnisallInputObservation[];
  nextOffset: number | null;
}


const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const onisallBindingContextSchema = z.object({
  pipelineId: z.string().uuid(), entryStageKey: z.string().min(1).max(200),
}).strict();
export const createOnisallBindingSchema = onisallBindingContextSchema.extend({
  projectId: z.string().uuid().nullable(), inputSha256: hash, configurationHash: hash,
}).strict();
export type OnisallBindingContextInput = z.infer<typeof onisallBindingContextSchema>;
export type CreateOnisallBinding = z.infer<typeof createOnisallBindingSchema>;
export interface OnisallNativeBinding {
  id: string;
  companyId: string;
  intakeId: string;
  snapshotId: string;
  inputSha256: string;
  pipelineId: string;
  projectId: string | null;
  caseId: string;
  entryStageKey: string;
  configurationHash: string;
  revision: 1;
  purpose: "preparation";
  executionAdmission: "not_granted";
  createdAt: string;
}
export interface OnisallBindingContext extends CreateOnisallBinding {
  protocol: "onisall.binding-context.v1";
  intakeId: string;
  binding: OnisallNativeBinding | null;
}
