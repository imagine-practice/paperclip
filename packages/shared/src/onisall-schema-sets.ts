export interface OnisallFrozenSchemaSet {
  protocol: "onisall.persisted-schema-set.v1";
  id: string; companyId: string;
  manifestSha256: string; schemaCount: number; totalByteSize: number;
  schemas: Array<{ registryKey: string; revision: string; sha256: string; byteSize: number }>;
  compiler: { protocol: "onisall.schema-compiler.v1"; ajvVersion: string; formatsVersion: string; profileSha256: string };
  purpose: "preparation"; executionAdmission: "not_granted"; createdAt: string;
}
export interface OnisallFrozenSchemaSetStatus {
  protocol: "onisall.schema-set-status.v1"; evaluatedAt: string; diagnosticsOnly: true;
  integrity: "verified";
  set: OnisallFrozenSchemaSet;
  currentCompiler: { profileSha256: string; matchesFrozenProfile: boolean };
  publication: { status: "unavailable"; executionAdmission: "not_granted" };
}
