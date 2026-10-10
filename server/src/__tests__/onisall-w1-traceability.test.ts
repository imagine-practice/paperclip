import { describe, expect, it } from "vitest";
import { createTraceabilityChecker } from "../services/onisall/checks/w1-traceability.js";
import { W1_TRACEABILITY_PROFILE, w1CoverageJsonSchema, type TraceabilityProfile, type W1CoverageIndex } from "../services/onisall/checks/w1-coverage.js";
import { captureInputText, sha256 } from "../services/onisall/input-snapshot.js";
import { createOfflineSchemaRegistry } from "../services/onisall/schema-registry.js";
import { freezeSchemaValidators } from "../services/onisall/schema-compiler.js";

const json = (value: unknown) => Buffer.from(JSON.stringify(value));
function fixture(source = Buffer.from("alpha\r\nbeta\ngamma\rdelta")) {
  const profile: TraceabilityProfile = { source_sha256: sha256(source), line_count: 4, groups: [
    { requirement_id: "W1-R01", ranges: [[1, 2]] }, { requirement_id: "W1-R02", ranges: [[3, 4]] },
  ] };
  const snapshot = captureInputText(source);
  const candidate: W1CoverageIndex = { kind: "w1_coverage_index", schema_version: 1, source_sha256: profile.source_sha256,
    groups: profile.groups.map(group => ({ requirement_id: group.requirement_id, disposition: "blocked", unresolved_ids: ["W1-D01"],
      criteria: group.ranges.map(([first, last], i) => ({ criterion_id: `${group.requirement_id}.${i}`, statement: "synthetic statement", verification_method: "synthetic method",
        basis: { kind: "source", first_line: first, last_line: last,
          quote_sha256: sha256(source.subarray(snapshot.lines[first - 1]!.byteStart, snapshot.lines[last - 1]!.byteEnd)) } })) })) };
  const checker = createTraceabilityChecker(profile);
  return { profile, source, candidate, checker, check: () => checker.check(json(candidate), source) };
}

describe("W1 deterministic traceability subcheck", () => {
  it("checks original byte offsets including mixed newlines without approving semantics", () => {
    const f = fixture(), result = f.check();
    expect(result.outcome).toBe("pass");
    expect(result.semantic_review).toBe("required");
    expect(result.authority).toBe("traceability_only");
    expect(result.counts).toEqual({ groups: 2, criteria: 2, source_references: 2, inferences: 0, blocked_groups: 2 });
    expect(result.candidate_sha256).toBe(sha256(json(f.candidate)));
    expect(Object.isFrozen(result.counts)).toBe(true);
    expect(result).not.toHaveProperty("evidence_refs");
  });
  it("permits explicit inference without letting it replace source coverage", () => {
    const f = fixture(), group = f.candidate.groups[0]!;
    group.criteria.push({ criterion_id: "inference", statement: "inferred", verification_method: "measure", basis: { kind: "inference", rationale: "assumption" } });
    expect(f.check().counts.inferences).toBe(1);
    expect(f.check().outcome).toBe("pass");
    group.criteria.shift(); expect(f.check().reason).toBe("source_coverage_missing");
  });
  it.each(["omit", "duplicate", "unexpected"])("rejects %s requirement groups", mode => {
    const f = fixture();
    if (mode === "omit") f.candidate.groups.pop();
    if (mode === "duplicate") f.candidate.groups[1] = structuredClone(f.candidate.groups[0]!);
    if (mode === "unexpected") f.candidate.groups[1]!.requirement_id = "W1-R12";
    expect(f.check().reason).toBe("group_coverage_mismatch");
  });
  it("rejects duplicate criterion IDs across distinct groups", () => {
    const f = fixture(); f.candidate.groups[1]!.criteria[0]!.criterion_id = f.candidate.groups[0]!.criteria[0]!.criterion_id;
    expect(f.check().reason).toBe("duplicate_criterion");
  });
  it.each(["reverse", "outside", "other_group", "hash", "partial"])("rejects %s source citations", mode => {
    const f = fixture(), basis = f.candidate.groups[0]!.criteria[0]!.basis;
    if (basis.kind !== "source") throw new Error("fixture");
    if (mode === "reverse") { basis.first_line = 2; basis.last_line = 1; }
    if (mode === "outside") basis.last_line = 5;
    if (mode === "other_group") { basis.first_line = 3; basis.last_line = 4; }
    if (mode === "hash") basis.quote_sha256 = "0".repeat(64);
    if (mode === "partial") { basis.last_line = 1; basis.quote_sha256 = sha256(Buffer.from("alpha")); }
    expect(f.check().reason).toBe(mode === "hash" ? "quote_mismatch" : mode === "partial" ? "source_coverage_missing" : "invalid_locator");
  });
  it.each(["empty_blocked", "unresolved_specified", "duplicate_unresolved"])("requires consistent disposition %s", mode => {
    const f = fixture(), group = f.candidate.groups[0]!;
    if (mode === "empty_blocked") group.unresolved_ids = [];
    if (mode === "unresolved_specified") group.disposition = "specified";
    if (mode === "duplicate_unresolved") group.unresolved_ids.push("W1-D01");
    expect(f.check().reason).toBe("invalid_disposition");
  });
  it.each(["statement", "verification_method"] as const)("rejects blank %s", field => {
    const f = fixture(); f.candidate.groups[0]!.criteria[0]![field] = " \n\t";
    expect(f.check().reason).toBe("blank_criterion");
  });
  it("rejects blank inference rationale and unknown fields", () => {
    const f = fixture(); f.candidate.groups[0]!.criteria[0]!.basis = { kind: "inference", rationale: " " };
    expect(f.check().reason).toBe("blank_criterion");
    Object.assign(f.candidate, { private_text: "secret" });
    expect(f.check().reason).toBe("invalid_candidate");
  });
  it("requires the actual source bytes and candidate source binding", () => {
    const f = fixture();
    expect(f.checker.check(json(f.candidate), Buffer.from("other source")).reason).toBe("source_mismatch");
    f.candidate.source_sha256 = "0".repeat(64); expect(f.check().reason).toBe("source_mismatch");
    expect(f.checker.check(json(f.candidate), Buffer.alloc(0)).reason).toBe("invalid_source");
    expect(f.checker.check(json(f.candidate), Buffer.alloc(1024 * 1024 + 1)).reason).toBe("invalid_source");
    const invalid = Buffer.from([0xc3, 0x28]);
    const invalidChecker = createTraceabilityChecker({ ...f.profile, source_sha256: sha256(invalid) });
    expect(invalidChecker.check(json(f.candidate), invalid).reason).toBe("invalid_source");
  });
  it("rejects duplicate wire keys, invalid numbers, oversized and malformed candidates", () => {
    const f = fixture();
    for (const bytes of [Buffer.from('{"a":1,"a":2}'), Buffer.from('{"a":1.5}'), Buffer.from("\ufeff{}"), Buffer.from([0xc3, 0x28]), Buffer.alloc(1024 * 1024 + 1)]) {
      expect(f.checker.check(bytes, f.source).reason).toBe("invalid_candidate");
    }
  });
  it("owns deployment profile copies and validates profile ranges", () => {
    const f = fixture(), before = f.check();
    Reflect.set(f.profile, "source_sha256", "0".repeat(64));
    Reflect.set(f.profile.groups[0]!.ranges[0]!, "0", 4);
    expect(f.check()).toEqual(before);
    for (const ranges of [[[2, 1]], [[0, 1]], [[1, 5]], [[1, 2], [2, 3]]]) {
      expect(() => createTraceabilityChecker({ ...fixture().profile, groups: [{ requirement_id: "W1-R01", ranges: ranges as [number, number][] }] })).toThrow("invalid_profile");
    }
    expect(W1_TRACEABILITY_PROFILE.groups).toHaveLength(12);
    expect(Object.isFrozen(W1_TRACEABILITY_PROFILE.groups[0]!.ranges[0])).toBe(true);
  });
  it("exports a closed 2020-12 schema from the actual TypeScript structure", () => {
    const bytes = json(w1CoverageJsonSchema());
    const ref = { registry_key: "w1/coverage-index", revision: "1", sha256: sha256(bytes) };
    const schemas = freezeSchemaValidators(createOfflineSchemaRegistry([{ ref, bytes }]), [ref]);
    const f = fixture(); expect(schemas.validate(ref, json(f.candidate)).valid).toBe(true);
    Object.assign(f.candidate.groups[0]!, { unknown: true });
    expect(schemas.validate(ref, json(f.candidate)).valid).toBe(false);
  });
});
