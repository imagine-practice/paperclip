import type { OnisallIntakeDraft, OnisallPreparationStatus } from "@paperclipai/shared";
import { conflict } from "../../errors.js";
import { captureInputText, InputSnapshotError } from "./input-snapshot.js";

/** Internal projection of a scoped DB read and storage bytes, not user claims. */
export function preparationStatus(draft: OnisallIntakeDraft, bytes: Buffer, observedAt: Date): OnisallPreparationStatus {
  const snapshot = draft.initialSnapshot;
  let captured: ReturnType<typeof captureInputText>;
  try { captured = captureInputText(bytes); }
  catch (error) {
    if (error instanceof InputSnapshotError) throw conflict("Stored input format differs");
    throw error;
  }
  if (snapshot.companyId !== draft.companyId || snapshot.protocol !== captured.protocol
    || snapshot.sha256 !== captured.sha256 || snapshot.byteSize !== captured.byteSize
    || snapshot.lineCount !== captured.lineCount || snapshot.hasBom !== captured.hasBom || captured.lineCount > 10000) {
    throw conflict("Stored input metadata differs");
  }
  const binding = draft.binding;
  if (draft.bindingStatus !== (binding ? "bound" : "binding_pending")
    || (!binding && (draft.caseId !== null || draft.projectId !== null))
    || (binding && (binding.companyId !== draft.companyId || binding.intakeId !== draft.id
      || binding.snapshotId !== snapshot.id || binding.inputSha256 !== snapshot.sha256
      || binding.caseId !== draft.caseId || binding.projectId !== draft.projectId
      || binding.revision !== 1 || binding.purpose !== "preparation" || binding.executionAdmission !== "not_granted"))) {
    throw conflict("Intake binding projection differs");
  }
  return {
    protocol: "onisall.intake-preparation-status.v1", evaluatedAt: observedAt.toISOString(),
    companyId: draft.companyId, intakeId: draft.id, diagnosticsOnly: true,
    input: { status: "verified", snapshotId: snapshot.id, sha256: snapshot.sha256,
      byteSize: snapshot.byteSize, lineCount: snapshot.lineCount },
    nativeBinding: binding ? { status: "recorded", bindingId: binding.id, caseId: binding.caseId,
      revision: binding.revision } : { status: "pending" },
    publication: { status: "unavailable", reason: "publication_not_implemented", executionAdmission: "not_granted" },
    remainingChecks: (["native_current_head", "contract_preflight", "checks_and_independent_review",
      "human_decisions", "execution_qualification", "budget_and_permissions"] as const)
      .map(code => ({ code, status: "not_evaluated" })),
  };
}
