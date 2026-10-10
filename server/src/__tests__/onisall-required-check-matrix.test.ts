import { describe, expect, it } from "vitest";
import { createOfflineCheckRegistry, preparationHash, preparationJson, type CheckDescriptor } from "../services/onisall/check-registry.js";
import { prepareRequiredCheckMatrix, type MatrixPreparationInput, type ArtifactTargetInventory } from "../services/onisall/required-check-matrix.js";
import { createOfflineSchemaRegistry } from "../services/onisall/schema-registry.js";
import { freezeSchemaValidators } from "../services/onisall/schema-compiler.js";
import { sha256 } from "../services/onisall/input-snapshot.js";

// Synthetic deployment bytes only: these are never executed or registered as W1 checkers.
const bytes = Buffer.from("synthetic checker fixture");
const schemaBytes = Buffer.from('{"type":"object"}');
const ref = { registry_key: "synthetic", revision: "1", sha256: sha256(schemaBytes) };
const schemas = freezeSchemaValidators(createOfflineSchemaRegistry([{ ref, bytes: schemaBytes }]), [ref]);
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
function asset(target_kinds: CheckDescriptor["target_kinds"] = ["artifact"], check_id = "shape") {
  return { descriptor: { check: { check_id, revision: "1", validator_sha256: sha256(bytes) },
    target_kinds, evidence_mode: "machine" as const }, validatorBytes: Buffer.from(bytes) };
}
function fixture(kinds: CheckDescriptor["target_kinds"] = ["artifact"]) {
  const entry = asset(kinds);
  const registry = createOfflineCheckRegistry([entry]);
  const input: MatrixPreparationInput = {
    artifact_requirements: [{ artifact_kind: "report_json", minimum_count: 1, schema_ref: { ...ref }, required_checks: [{ ...entry.descriptor.check }] }],
    output_bounds: [{ artifact_kind: "report_json", max_count: 2, max_sources_per_artifact: 2, max_claims_per_artifact: 3 }],
  };
  const inventory: ArtifactTargetInventory = { artifact_set_hash: "a".repeat(64), artifacts: [
    { artifact_id: id(1), revision: 1, artifact_kind: "report_json", source_ids: [id(10)], claim_ids: ["uncited", "cited"] },
    { artifact_id: id(2), revision: 1, artifact_kind: "report_json", source_ids: [id(10), id(11)], claim_ids: ["other"] },
  ] };
  return { entry, registry, input, inventory, prepare: () => prepareRequiredCheckMatrix(input, registry, schemas) };
}

describe("trusted check asset registry", () => {
  it("binds bytes and freezes independent metadata copies", () => {
    const item = asset(["claim", "artifact"]);
    const reference = { ...item.descriptor.check };
    const registry = createOfflineCheckRegistry([item]);
    item.validatorBytes.fill(0); item.descriptor.target_kinds.length = 0; item.descriptor.check.revision = "2";
    const resolved = registry.resolve(reference);
    expect(resolved.target_kinds).toEqual(["artifact", "claim"]);
    for (const value of [resolved, resolved.check, resolved.target_kinds]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => registry.resolve({ ...reference, revision: "2" })).toThrow("not_registered");
    expect(() => registry.resolve({ ...reference, validator_sha256: "0".repeat(64) })).toThrow("digest_mismatch");
  });
  it("rejects changed bytes and metadata under a fixed revision", () => {
    const first = asset();
    const second = asset(["claim"]);
    expect(() => createOfflineCheckRegistry([first, second])).toThrow("revision_conflict");
    const changed = Buffer.from("changed fixture");
    second.validatorBytes = changed; second.descriptor.check.validator_sha256 = sha256(changed);
    expect(() => createOfflineCheckRegistry([first, second])).toThrow("revision_conflict");
    expect(() => createOfflineCheckRegistry([{ ...first, validatorBytes: changed }])).toThrow("digest_mismatch");
    expect(createOfflineCheckRegistry([first, first]).resolve(first.descriptor.check)).toEqual(first.descriptor);
  });
  it.each(["latest", "main", "master", "HEAD", "", "\ud800"])("refuses unstable/invalid revision %s", value => {
    const item = asset(); item.descriptor.check.revision = value;
    expect(() => createOfflineCheckRegistry([item])).toThrow("invalid_input");
  });
  it("rejects empty, oversized, duplicate and unexpected registration data", () => {
    expect(() => createOfflineCheckRegistry([])).toThrow("invalid_input");
    expect(() => createOfflineCheckRegistry(Array(501).fill(asset()))).toThrow("invalid_input");
    expect(() => createOfflineCheckRegistry([asset(["claim", "claim"])] )).toThrow("duplicate_input");
    for (const validatorBytes of [Buffer.alloc(0), Buffer.alloc(1024 * 1024 + 1)]) {
      expect(() => createOfflineCheckRegistry([{ ...asset(), validatorBytes }])).toThrow("invalid_input");
    }
    const item = asset(); Object.assign(item.descriptor, { private_field: "private-value" });
    expect(() => createOfflineCheckRegistry([item])).toThrow(/^invalid_input$/);
  });
});

describe("required matrix capacity and expansion", () => {
  it("covers all four target kinds, including uncited claims; deduplicates shared sources/set", () => {
    const f = fixture(["artifact", "artifact_set", "source", "claim"]);
    const plan = f.prepare(), result = plan.expand(f.inventory);
    expect(plan.manifest.maximum_checks).toBe(13); // 2 * (1 + 2 + 3) + 1
    expect(result.projection.checks).toHaveLength(8); // 2 artifacts + set + 2 sources + 3 claims
    expect(result.projection.checks.every(check => check.blocking)).toBe(true);
    expect(result.projection.checks.some(check => check.target.kind === "claim" && check.target.claim_id === "uncited")).toBe(true);
    expect(result.requiredMatrixHash).toBe(preparationHash(result.projection));
    expect(() => plan.assertCoverage(f.inventory, result.projection.checks)).not.toThrow();
    expect(result).not.toHaveProperty("decision");
  });
  it("canonicalizes all input orders and keeps copies immutable", () => {
    const f = fixture(["source", "claim", "artifact_set", "artifact"]);
    const plan = f.prepare(), original = plan.expand(f.inventory);
    f.inventory.artifacts.reverse();
    for (const a of f.inventory.artifacts) { a.claim_ids.reverse(); a.source_ids.reverse(); }
    expect(plan.expand(f.inventory)).toEqual(original);
    f.input.output_bounds[0]!.max_count = 999;
    f.input.artifact_requirements[0]!.required_checks[0]!.revision = "mutated";
    expect(plan.expand(f.inventory)).toEqual(original);
    for (const value of [plan.manifest, plan.manifest.output_bounds[0], original.projection,
      original.projection.checks, original.projection.checks[0]!.target]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => plan.assertCoverage(f.inventory, [...original.projection.checks].reverse())).not.toThrow();
  });
  it.each(["artifact", "source", "claim", "artifact_set"] as const)("budgets %s targets at the 500 boundary", kind => {
    const f = fixture([kind]);
    f.input.output_bounds[0] = { artifact_kind: "report_json", max_count: kind === "artifact_set" ? 1000 : 500,
      max_sources_per_artifact: 1, max_claims_per_artifact: 1 };
    expect(f.prepare().manifest.maximum_checks).toBe(kind === "artifact_set" ? 1 : 500);
    if (kind !== "artifact_set") {
      f.input.output_bounds[0]!.max_count = 501;
      expect(f.prepare).toThrow("capacity_exceeded");
    }
  });
  it("expands exactly 500 checks and refuses over-bound output", () => {
    const f = fixture(); f.input.output_bounds[0]!.max_count = 500;
    f.inventory.artifacts = Array.from({ length: 500 }, (_, i) => ({ ...f.inventory.artifacts[0]!, artifact_id: id(i) }));
    const plan = f.prepare(); expect(plan.expand(f.inventory).projection.checks).toHaveLength(500);
    f.inventory.artifacts.push({ ...f.inventory.artifacts[0]!, artifact_id: id(999) });
    expect(() => plan.expand(f.inventory)).toThrow("invalid_bounds");
  });
  it("deduplicates a set-wide check shared by distinct required artifact kinds", () => {
    const f = fixture(["artifact_set", "source"]);
    f.input.artifact_requirements.push({ ...structuredClone(f.input.artifact_requirements[0]!), artifact_kind: "report_html" });
    f.input.output_bounds.push({ ...f.input.output_bounds[0]!, artifact_kind: "report_html" });
    f.inventory.artifacts[1]!.artifact_kind = "report_html";
    const plan = f.prepare(); expect(plan.manifest.maximum_checks).toBe(9);
    expect(plan.expand(f.inventory).projection.checks).toHaveLength(3);
    f.input.artifact_requirements.reverse(); f.input.output_bounds.reverse();
    expect(f.prepare().planSha256).toBe(plan.planSha256);
  });
  it("fingerprints output bounds, validator metadata, assets and inventory", () => {
    const f = fixture(); const first = f.prepare();
    f.input.output_bounds[0]!.max_count = 3;
    expect(f.prepare().planSha256).not.toBe(first.planSha256);
    const human = { ...f.entry, descriptor: { ...f.entry.descriptor, evidence_mode: "authenticated_human" as const } };
    const humanPlan = prepareRequiredCheckMatrix(f.input, createOfflineCheckRegistry([human]), schemas);
    expect(humanPlan.planSha256).not.toBe(f.prepare().planSha256);
    expect(humanPlan.manifest.checks[0]!.evidence_mode).toBe("authenticated_human");
    const changedBytes = Buffer.from("another synthetic checker fixture");
    const changed = { ...f.entry, validatorBytes: changedBytes, descriptor: { ...f.entry.descriptor,
      check: { ...f.entry.descriptor.check, validator_sha256: sha256(changedBytes) } } };
    const updated = structuredClone(f.input);
    updated.artifact_requirements[0]!.required_checks = [changed.descriptor.check];
    expect(prepareRequiredCheckMatrix(updated, createOfflineCheckRegistry([changed]), schemas).planSha256).not.toBe(f.prepare().planSha256);
    const original = first.expand(f.inventory).requiredMatrixHash;
    f.inventory.artifact_set_hash = "b".repeat(64);
    expect(first.expand(f.inventory).requiredMatrixHash).not.toBe(original);
  });
  it.each([
    ["missing bound", (f: ReturnType<typeof fixture>) => { f.input.output_bounds = []; }],
    ["float", (f: ReturnType<typeof fixture>) => { f.input.output_bounds[0]!.max_count = 1.5; }],
    ["unsafe", (f: ReturnType<typeof fixture>) => { f.input.artifact_requirements[0]!.minimum_count = Number.MAX_SAFE_INTEGER + 1; }],
    ["negative zero", (f: ReturnType<typeof fixture>) => { f.input.output_bounds[0]!.max_claims_per_artifact = -0; }],
    ["unknown field", (f: ReturnType<typeof fixture>) => { Object.assign(f.input, { private_text: "secret" }); }],
  ])("rejects malformed preparation %s", (_, change) => {
    const f = fixture(); change(f); expect(f.prepare).toThrow(/^invalid_input$/);
  });
  it("requires unique requirements/checks/bounds and registered checks/frozen schemas", () => {
    for (const part of ["artifact_requirements", "output_bounds"] as const) {
      const f = fixture(); (f.input[part] as unknown[]).push(structuredClone(f.input[part][0]));
      expect(f.prepare).toThrow("duplicate_input");
    }
    const duplicate = fixture(); duplicate.input.artifact_requirements[0]!.required_checks.push(duplicate.entry.descriptor.check);
    expect(duplicate.prepare).toThrow("duplicate_input");
    const missing = fixture(); missing.input.artifact_requirements[0]!.required_checks[0]!.check_id = "missing";
    expect(missing.prepare).toThrow("not_registered");
    const schema = fixture(); schema.input.artifact_requirements[0]!.schema_ref.sha256 = "0".repeat(64);
    expect(schema.prepare).toThrow("schema_not_frozen");
    const digest = fixture(); digest.input.artifact_requirements[0]!.required_checks[0]!.validator_sha256 = "0".repeat(64);
    expect(digest.prepare).toThrow("digest_mismatch");
  });
  it("rejects mixing revisions of one logical check across artifact kinds", () => {
    const f = fixture(["artifact_set"]), second = asset(["artifact_set"]);
    second.descriptor.check.revision = "2";
    f.input.artifact_requirements.push({ ...f.input.artifact_requirements[0]!, artifact_kind: "report_html", required_checks: [second.descriptor.check] });
    f.input.output_bounds.push({ ...f.input.output_bounds[0]!, artifact_kind: "report_html" });
    expect(() => prepareRequiredCheckMatrix(f.input, createOfflineCheckRegistry([f.entry, second]), schemas)).toThrow("revision_conflict");
  });
  it("includes set-wide checks in the total limit", () => {
    const f = fixture(["artifact", "artifact_set"]);
    f.input.output_bounds[0]!.max_count = 499;
    expect(f.prepare().manifest.maximum_checks).toBe(500);
    f.input.output_bounds[0]!.max_count = 500;
    expect(f.prepare).toThrow("capacity_exceeded");
  });
  it("refuses impossible/extra bounds, total artifacts over 1000 and empty target budgets", () => {
    const low = fixture(); low.input.output_bounds[0]!.max_count = 0; expect(low.prepare).toThrow("invalid_bounds");
    const extra = fixture(); extra.input.output_bounds[0]!.artifact_kind = "report_html"; expect(extra.prepare).toThrow("invalid_bounds");
    const total = fixture(["artifact_set"]); total.input.output_bounds[0]!.max_count = 1000;
    total.input.artifact_requirements.push({ ...total.input.artifact_requirements[0]!, artifact_kind: "report_html" });
    total.input.output_bounds.push({ ...total.input.output_bounds[0]!, artifact_kind: "report_html", max_count: 1 });
    expect(total.prepare).toThrow("invalid_bounds");
    for (const kind of ["claim", "source"] as const) {
      const f = fixture([kind]);
      f.input.output_bounds[0]![kind === "claim" ? "max_claims_per_artifact" : "max_sources_per_artifact"] = 0;
      expect(f.prepare).toThrow("invalid_bounds");
    }
  });
  it.each(["source_ids", "claim_ids"] as const)("rejects duplicate, empty-required and over-bound %s", field => {
    const f = fixture([field === "source_ids" ? "source" : "claim"]), plan = f.prepare();
    const a = f.inventory.artifacts[0]!;
    a[field].push(a[field][0]!); expect(() => plan.expand(f.inventory)).toThrow("duplicate_input");
    a[field] = []; expect(() => plan.expand(f.inventory)).toThrow("empty_targets");
    a[field] = field === "source_ids" ? [id(10), id(11), id(12)] : ["a", "b", "c", "d"];
    expect(() => plan.expand(f.inventory)).toThrow("invalid_bounds");
  });
  it("rejects duplicate artifact revisions, forbidden kinds, unmet minimums and unknown artifacts", () => {
    const f = fixture(), plan = f.prepare();
    f.inventory.artifacts.push(structuredClone(f.inventory.artifacts[0]!));
    expect(() => plan.expand(f.inventory)).toThrow("duplicate_input");
    f.inventory.artifacts.pop(); f.inventory.artifacts[0]!.artifact_kind = "report_html";
    expect(() => plan.expand(f.inventory)).toThrow("unexpected_artifact");
    Object.assign(f.inventory.artifacts[0]!, { artifact_kind: "verification" });
    expect(() => plan.expand(f.inventory)).toThrow("invalid_input");
    const min = fixture(); min.input.artifact_requirements[0]!.minimum_count = 2; min.inventory.artifacts.pop();
    expect(() => min.prepare().expand(min.inventory)).toThrow("invalid_bounds");
  });
  it("rejects omitted, added, repeated, altered, nonblocking and invented target checks", () => {
    const f = fixture(["artifact", "claim"]), plan = f.prepare();
    const expected = () => structuredClone(plan.expand(f.inventory).projection.checks);
    const omitted = [...expected()]; omitted.pop(); expect(() => plan.assertCoverage(f.inventory, omitted)).toThrow("matrix_mismatch");
    expect(() => plan.assertCoverage(f.inventory, [])).toThrow("invalid_input");
    expect(() => plan.assertCoverage(f.inventory, [...expected(), expected()[0]!])).toThrow("duplicate_input");
    for (const patch of [{ validator_sha256: "b".repeat(64) }, { revision: "2" }, { check_id: "extra" },
      { target: { kind: "artifact", artifact_id: id(999), revision: 1 } }]) {
      const altered = [...expected()]; altered[0] = { ...altered[0]!, ...patch } as typeof altered[number];
      expect(() => plan.assertCoverage(f.inventory, altered)).toThrow("matrix_mismatch");
    }
    const nonblocking = [...expected()]; Object.assign(nonblocking[0]!, { blocking: false });
    expect(() => plan.assertCoverage(f.inventory, nonblocking)).toThrow("invalid_input");
    const extra = { ...expected()[0]!, check_id: "extra" };
    expect(() => plan.assertCoverage(f.inventory, [...expected(), extra])).toThrow("matrix_mismatch");
  });
});

describe("preparation fingerprint encoding", () => {
  it("uses sorted ASCII keys and exact Unicode without normalization", () => {
    expect(preparationJson({ z: "中文", a: [true, null, 1] })).toBe('{"a":[true,null,1],"z":"中文"}');
    expect(preparationHash({ x: "é" })).not.toBe(preparationHash({ x: "e\u0301" }));
  });
  it.each([NaN, Infinity, -1, -0, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined, "\ud800", { "非ASCII": 1 }])(
    "rejects unsupported hash values %#", value => expect(() => preparationHash(value)).toThrow("invalid_input"),
  );
});
