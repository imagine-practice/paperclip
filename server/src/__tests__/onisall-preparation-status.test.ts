import { describe, expect, it } from "vitest";
import type { OnisallIntakeDraft, OnisallNativeBinding } from "@paperclipai/shared";
import { captureInputText } from "../services/onisall/input-snapshot.js";
import { preparationStatus } from "../services/onisall/preparation-status.js";

const bytes = Buffer.from("private-source-canary\r\nsecond line\n");
const now = new Date("2026-10-10T02:00:00Z");
function fixture(): OnisallIntakeDraft {
  return { kind: "intake_draft", draftVersion: 2, id: "intake", companyId: "company",
    businessKey: "private-business-key", goal: "private-goal", sourceLabel: "private-label",
    status: "draft", bindingStatus: "binding_pending", controlMode: "native_pipeline", clientId: null,
    projectId: null, caseId: null, binding: null, contractId: null,
    initialSnapshot: { ...captureInputText(bytes), id: "snapshot", companyId: "company", createdAt: now.toISOString() },
    createdAt: now.toISOString() };
}
function bound(): OnisallIntakeDraft {
  const draft = fixture();
  draft.bindingStatus = "bound"; draft.caseId = "case";
  draft.binding = { id: "binding", companyId: draft.companyId, intakeId: draft.id,
    snapshotId: draft.initialSnapshot.id, inputSha256: draft.initialSnapshot.sha256,
    pipelineId: "pipeline", projectId: null, caseId: "case", entryStageKey: "intake",
    configurationHash: "a".repeat(64), revision: 1, purpose: "preparation",
    executionAdmission: "not_granted", createdAt: now.toISOString() };
  return draft;
}
describe("Read-only preparation projection (synthetic bytes)", () => {
  it("verifies input without publishing private prose or granting execution", () => {
    const result = preparationStatus(fixture(), bytes, now);
    expect(result).toMatchObject({ protocol: "onisall.intake-preparation-status.v1", evaluatedAt: now.toISOString(),
      diagnosticsOnly: true, input: { status: "verified", lineCount: 2 }, nativeBinding: { status: "pending" },
      publication: { status: "unavailable", executionAdmission: "not_granted" } });
    expect(result.remainingChecks).toHaveLength(6);
    expect(result.remainingChecks.every(check => check.status === "not_evaluated")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-");
  });
  it("records binding presence without claiming current-head validation", () => {
    const result = preparationStatus(bound(), bytes, now);
    expect(result.nativeBinding).toEqual({ status: "recorded", bindingId: "binding", caseId: "case", revision: 1 });
    expect(result.remainingChecks).toContainEqual({ code: "native_current_head", status: "not_evaluated" });
    expect(result.publication.executionAdmission).toBe("not_granted");
  });
  it.each([Buffer.from("tampered"), Buffer.from([0xff])])("rejects corrupt bytes without echoing content", changed => {
    expect(() => preparationStatus(fixture(), changed, now)).toThrow(/Stored input/);
  });
  it.each(["sha256", "byteSize", "lineCount", "hasBom", "companyId", "protocol"])("rejects inconsistent %s metadata", key => {
    const draft = fixture();
    Reflect.set(draft.initialSnapshot, key, key === "byteSize" || key === "lineCount" ? 900 : "corrupt");
    expect(() => preparationStatus(draft, bytes, now)).toThrow("Stored input metadata differs");
  });
  it.each(["companyId", "intakeId", "snapshotId", "inputSha256", "caseId", "projectId", "purpose", "executionAdmission", "revision"])("rejects inconsistent binding %s", key => {
    const draft = bound();
    Reflect.set(draft.binding as OnisallNativeBinding, key, "corrupt");
    expect(() => preparationStatus(draft, bytes, now)).toThrow("Intake binding projection differs");
  });
  it("rejects contradictory pending and bound projections", () => {
    const draft = fixture(); draft.bindingStatus = "bound";
    expect(() => preparationStatus(draft, bytes, now)).toThrow("Intake binding projection differs");
    draft.bindingStatus = "binding_pending"; draft.caseId = "orphan";
    expect(() => preparationStatus(draft, bytes, now)).toThrow("Intake binding projection differs");
  });
  it("does not share mutable results between reads", () => {
    const result = preparationStatus(fixture(), bytes, now);
    result.remainingChecks.length = 0;
    expect(preparationStatus(fixture(), bytes, now).remainingChecks).toHaveLength(6);
  });
});
