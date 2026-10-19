export type OnisallRuleKind = "check" | "command" | "runtime" | "policy";
export interface OnisallRuleAsset {
  kind: OnisallRuleKind; registryKey: string; revision: string; sha256: string; byteSize: number;
  check: { targetKinds: Array<"artifact" | "artifact_set" | "source" | "claim">;
    evidenceMode: "machine" | "authenticated_human" } | null;
}
export interface OnisallFrozenRuleSet {
  protocol: "onisall.persisted-rule-set.v1"; id: string; companyId: string; schemaSetId: string;
  manifestSha256: string; assetCount: number; totalByteSize: number; assets: OnisallRuleAsset[];
  purpose: "preparation"; executionAdmission: "not_granted"; createdAt: string;
}
export interface OnisallRuleSetCatalog {
  protocol: "onisall.rule-set-catalog.v1"; companyId: string; evaluatedAt: string;
  // Listings identify historical records; only the detail read verifies byte assets.
  sets: Array<Omit<OnisallFrozenRuleSet, "protocol" | "companyId" | "assets">>;
  nextOffset: number | null;
}
export interface OnisallFrozenRuleSetStatus {
  protocol: "onisall.rule-set-status.v1"; evaluatedAt: string; diagnosticsOnly: true;
  integrity: "verified"; set: OnisallFrozenRuleSet;
  preparation: { registry: "verified"; schemaCompilerMatches: boolean; schemaCompilation: "verified" | "profile_changed" };
  publication: { status: "unavailable"; executionAdmission: "not_granted" };
  qualification: { sandbox: "not_evaluated"; businessAcceptance: "not_evaluated" };
}
