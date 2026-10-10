import { z } from "zod";

// Draft transport v1 is deliberately separate from published TaskContract v3.
export const ONISALL_INTAKE_DRAFT_VERSION = 1 as const;
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
  draftVersion: 1;
  id: string;
  companyId: string;
  businessKey: string;
  goal: string;
  sourceLabel: string;
  status: "draft";
  bindingStatus: "binding_pending";
  controlMode: "native_pipeline";
  // No placeholder IDs or implied published authority.
  clientId: null;
  projectId: null;
  caseId: null;
  contractId: null;
  initialSnapshot: OnisallInputSnapshot;
  createdAt: string;
}
export interface OnisallObservationPage {
  observations: OnisallInputObservation[];
  nextOffset: number | null;
}
