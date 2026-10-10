import { describe, expect, it } from "vitest";
import { parseStrictJson, STRICT_JSON_LIMITS } from "../services/onisall/strict-json.js";
import { createOfflineCheckRegistry, preparationHash } from "../services/onisall/check-registry.js";
import { createOfflineCommandRegistry, type CommandAssetDescriptor, type CheckSandboxPolicy } from "../services/onisall/command-registry.js";
import { acceptanceCriteriaProjection, createContractPreflight } from "../services/onisall/contract-preflight.js";
import { createOfflineSchemaRegistry } from "../services/onisall/schema-registry.js";
import { sha256 } from "../services/onisall/input-snapshot.js";
import type { MatrixPreparationInput } from "../services/onisall/required-check-matrix.js";

const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const pinned = (key: string, bytes: Buffer) => ({ ref: { registry_key: key, revision: "1", sha256: sha256(bytes) }, bytes });
function setup() {
  const validatorBytes = Buffer.from("synthetic validator; never executed");
  const check = { check_id: "shape", revision: "1", validator_sha256: sha256(validatorBytes) };
  const checks = createOfflineCheckRegistry([{ descriptor: { check, target_kinds: ["artifact"], evidence_mode: "machine" }, validatorBytes }]);
  const runtime = pinned("runtime", Buffer.from("synthetic runtime; never executed"));
  const policy: CheckSandboxPolicy = { protocol: "onisall.check-sandbox.v1", network: "deny", workspace: "read_only", environment: "empty", child_processes: "deny" };
  const sandbox = pinned("sandbox", json(policy));
  const descriptor: CommandAssetDescriptor = { protocol: "onisall.verification-command.v1", validator: check,
    runtime_ref: runtime.ref, argv: ["$VALIDATOR", "--json"], cwd: "isolated_artifact_workspace", shell: false,
    timeout_ms: 1000, sandbox_policy_ref: sandbox.ref };
  const asset = pinned("command", json(descriptor));
  const options = { commands: [asset], runtimes: [runtime], policies: [sandbox], checks };
  const command = { command_id: "shape", ref: asset.ref, validator: check };
  const commands = createOfflineCommandRegistry(options);
  // Unit fixture isolates orchestration; authoritative v3 tests live in the
  // workspace replay script, so fork tests never depend on a parent checkout.
  const contractSchema = pinned("contract", json({ $id: "urn:onisall:paperclip:capability-contracts:3",
    type: "object", required: ["kind", "schema_version", "contract_id", "revision", "artifact_requirements", "verification_commands", "limits"],
    properties: { kind: { const: "task_contract" }, schema_version: { const: 3 }, revision: { type: "integer", minimum: 1 } } }));
  const artifactSchema = pinned("artifact", json({ type: "object" }));
  const schemas = createOfflineSchemaRegistry([contractSchema, artifactSchema]);
  const candidate = { kind: "task_contract", schema_version: 3, contract_id: "00000000-0000-0000-0000-000000000001", revision: 1,
    status: "published", goal: "synthetic", limits: { max_execution_seconds: 1 },
    artifact_requirements: [{ artifact_kind: "report_json" as const, minimum_count: 1, schema_ref: artifactSchema.ref, required_checks: [check] }],
    verification_commands: [command] };
  const bounds: MatrixPreparationInput["output_bounds"] = [{ artifact_kind: "report_json", max_count: 1, max_sources_per_artifact: 0, max_claims_per_artifact: 0 }];
  const factoryOptions = { contractSchemaRef: contractSchema.ref, schemas, checks, commands };
  const preflight = createContractPreflight(factoryOptions);
  return { validatorBytes, check, checks, runtime, policy, sandbox, descriptor, asset, options, command,
    commands, candidate, bounds, factoryOptions, preflight, inspect: () => preflight.inspect(json(candidate), bounds) };
}

describe("strict contract JSON wire profile", () => {
  it("handles JSON grammar, escaped strings and Unicode without normalization", () => {
    const value = { a: [true, false, null, 0, Number.MAX_SAFE_INTEGER, "中文", "😀", "é", "e\u0301", '"\\\n\t\r'] };
    expect(parseStrictJson(json(value))).toEqual(value);
    expect(parseStrictJson(Buffer.from(" \t\r\n[] \n"))).toEqual([]);
  });
  it.each(['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"a":[{"x":1,"x":2}]}', '{"__proto__":1,"__proto__":2}'])(
    "rejects duplicate decoded names %#", value => expect(() => parseStrictJson(Buffer.from(value))).toThrow("duplicate_key"),
  );
  it.each(["", " ", "{}[]", "[1,]", '{"x":1,}', '{"x" 1}', '{x:1}', "NaN", "Infinity", "01", '"bad\nstring"', '"\\q"', '"\\uD800"', '"\\uDC00"', '"unfinished', "\ufeff{}"])(
    "rejects malformed wire %#", value => expect(() => parseStrictJson(Buffer.from(value))).toThrow("invalid_json"),
  );
  it.each(["-1", "-0", "1.0", "1e0", "1e999", "9007199254740992"])(
    "rejects non-profile numeric tokens %s", value => expect(() => parseStrictJson(Buffer.from(value))).toThrow("invalid_number"),
  );
  it("preserves prototype-looking names as data", () => {
    const value = parseStrictJson(Buffer.from('{"__proto__":{"polluted":true},"constructor":1}')) as object;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect({}).not.toHaveProperty("polluted");
  });
  it("bounds bytes, nodes, depth and rejects malformed UTF-8", () => {
    expect(() => parseStrictJson(Buffer.alloc(STRICT_JSON_LIMITS.bytes + 1))).toThrow("input_too_large");
    expect(() => parseStrictJson(json(Array(50_000).fill(null)))).toThrow("input_too_large");
    expect(() => parseStrictJson(Buffer.from("[".repeat(102) + "0" + "]".repeat(102)))).toThrow("input_too_large");
    expect(() => parseStrictJson(Buffer.from([0xc3, 0x28]))).toThrow("invalid_json");
  });
});

describe("offline command registry", () => {
  it("resolves exact assets without execution and freezes independent copies", () => {
    const f = setup(), original = structuredClone(f.command);
    const result = f.commands.resolve(original);
    f.asset.bytes.fill(0); f.runtime.bytes.fill(0); f.sandbox.bytes.fill(0); f.asset.ref.revision = "changed";
    expect(f.commands.resolve(original)).toEqual(result);
    for (const value of [result, result.ref, result.descriptor, result.descriptor.argv, result.sandbox_policy]) expect(Object.isFrozen(value)).toBe(true);
    expect(result.runtime_ref.sha256).toBe(sha256(Buffer.from("synthetic runtime; never executed")));
  });
  it("rejects unknown references, changed digests and validator substitution", () => {
    const f = setup();
    expect(() => f.commands.resolve({ ...f.command, ref: { ...f.command.ref, revision: "2" } })).toThrow("not_registered");
    expect(() => f.commands.resolve({ ...f.command, ref: { ...f.command.ref, sha256: "0".repeat(64) } })).toThrow("digest_mismatch");
    expect(() => f.commands.resolve({ ...f.command, validator: { ...f.check, check_id: "other" } })).toThrow("validator_mismatch");
  });
  it.each(["commands", "runtimes", "policies"] as const)("checks actual %s bytes and immutable revisions", part => {
    const f = setup(), asset = f.options[part][0]!;
    const changed = pinned(asset.ref.registry_key, Buffer.from("different"));
    f.options[part].push(changed);
    expect(() => createOfflineCommandRegistry(f.options)).toThrow("revision_conflict");
    f.options[part] = [{ ...asset, bytes: Buffer.from("different") }];
    expect(() => createOfflineCommandRegistry(f.options)).toThrow("digest_mismatch");
  });
  it.each([{ shell: true }, { argv: [] }, { argv: ["$VALIDATOR", "$VALIDATOR"] }, { argv: ["\0"] },
    { timeout_ms: 0 }, { cwd: "../../other" }, { unknown: "private" }])("rejects unsupported command descriptors %#", patch => {
    const f = setup(); f.options.commands = [pinned("command", json({ ...f.descriptor, ...patch }))];
    expect(() => createOfflineCommandRegistry(f.options)).toThrow(/^invalid_input$/);
  });
  it("rejects missing runtime/policy/check assets and permissive policies", () => {
    for (const property of ["runtime_ref", "sandbox_policy_ref"] as const) {
      const f = setup(); f.descriptor[property] = { ...f.descriptor[property], revision: "missing" };
      f.options.commands = [pinned("command", json(f.descriptor))];
      expect(() => createOfflineCommandRegistry(f.options)).toThrow("not_registered");
    }
    const f = setup(); f.descriptor.validator = { ...f.check, revision: "missing" };
    f.options.commands = [pinned("command", json(f.descriptor))];
    expect(() => createOfflineCommandRegistry(f.options)).toThrow("not_registered");
    const weak = setup(), policy = pinned("sandbox", json({ ...weak.policy, network: "allow" }));
    weak.descriptor.sandbox_policy_ref = policy.ref;
    weak.options.policies = [policy]; weak.options.commands = [pinned("command", json(weak.descriptor))];
    expect(() => createOfflineCommandRegistry(weak.options)).toThrow("invalid_input");
  });
});

describe("contract offline preflight", () => {
  it("combines assets, schemas, output bounds and hashes without trusting published as authorization", () => {
    const f = setup(), result = f.inspect();
    expect(result.snapshot.status).toBe("offline_prepared");
    expect(result.snapshot.execution_admission).toBe("not_granted");
    expect(result.snapshot.acceptance_criteria_hash).toBe(preparationHash(acceptanceCriteriaProjection(f.candidate)));
    expect(result.snapshotSha256).toBe(preparationHash(result.snapshot));
    expect(result.snapshot.required_check_plan_sha256).toBe(result.matrix.planSha256);
    expect(result.snapshot.commands).toHaveLength(1);
    expect(Object.isFrozen(result.snapshot.commands[0]!.descriptor.argv)).toBe(true);
  });
  it("binds fields outside acceptance criteria and preserves exact input bytes", () => {
    const f = setup(), result = f.inspect();
    f.candidate.goal = "changed";
    const changed = f.inspect();
    expect(changed.snapshot.acceptance_criteria_hash).toBe(result.snapshot.acceptance_criteria_hash);
    expect(changed.snapshotSha256).not.toBe(result.snapshotSha256);
    expect(f.preflight.inspect(Buffer.from(JSON.stringify(f.candidate, null, 2)), f.bounds).snapshotSha256).not.toBe(changed.snapshotSha256);
    f.bounds[0]!.max_count = 2;
    expect(f.inspect().snapshotSha256).not.toBe(changed.snapshotSha256);
    expect(result.snapshot.output_bounds[0]!.max_count).toBe(1);
  });
  it("rejects malformed contract shapes and duplicate command identifiers", () => {
    const f = setup();
    for (const value of [null, [], {}, { ...f.candidate, kind: "gate_verdict" }, { ...f.candidate, schema_version: 2 }, { ...f.candidate, revision: 0 }]) {
      expect(() => f.preflight.inspect(json(value), f.bounds)).toThrow("invalid_contract");
    }
    f.candidate.verification_commands.push(f.command);
    expect(f.inspect).toThrow("duplicate_command");
  });
  it("rejects multiple command aliases for one check and timeouts above contract limits", () => {
    const f = setup(); f.candidate.verification_commands.push({ ...f.command, command_id: "alias" });
    expect(f.inspect).toThrow("ambiguous_command");
    const slow = setup(); slow.descriptor.timeout_ms = 1001;
    slow.options.commands = [pinned("command", json(slow.descriptor))];
    slow.candidate.verification_commands[0]!.ref = slow.options.commands[0]!.ref;
    const preflight = createContractPreflight({ ...slow.factoryOptions, commands: createOfflineCommandRegistry(slow.options) });
    expect(() => preflight.inspect(json(slow.candidate), slow.bounds)).toThrow("timeout_exceeds_limit");
  });
  it("rejects missing and unexpected required-check coverage", () => {
    const f = setup();
    const second = { ...f.check, check_id: "second" };
    const checks = createOfflineCheckRegistry([f.check, second].map(check => ({ descriptor: { check, target_kinds: ["artifact"], evidence_mode: "machine" }, validatorBytes: f.validatorBytes })));
    f.candidate.artifact_requirements[0]!.required_checks.push(second);
    const preflight = createContractPreflight({ ...f.factoryOptions, checks });
    expect(() => preflight.inspect(json(f.candidate), f.bounds)).toThrow("incomplete_coverage");
    f.candidate.artifact_requirements[0]!.required_checks = [second];
    expect(() => preflight.inspect(json(f.candidate), f.bounds)).toThrow("unexpected_check");
  });
  it("rejects differing metadata between trusted check and command registries", () => {
    const f = setup();
    const checks = createOfflineCheckRegistry([{ descriptor: { check: f.check, target_kinds: ["artifact"], evidence_mode: "authenticated_human" }, validatorBytes: f.validatorBytes }]);
    const preflight = createContractPreflight({ ...f.factoryOptions, checks });
    expect(() => preflight.inspect(json(f.candidate), f.bounds)).toThrow("check_metadata_mismatch");
  });
  it("checks registry/compiler identity and retains captured factory references", () => {
    const f = setup();
    const wrong = pinned("contract", json({ type: "object" }));
    expect(() => createContractPreflight({ ...f.factoryOptions, contractSchemaRef: wrong.ref,
      schemas: createOfflineSchemaRegistry([wrong]) })).toThrow("invalid_schema_profile");
    const before = f.inspect();
    f.factoryOptions.schemas = createOfflineSchemaRegistry([wrong]);
    expect(f.inspect().snapshotSha256).toBe(before.snapshotSha256);
    f.candidate.artifact_requirements[0]!.schema_ref.sha256 = "0".repeat(64);
    expect(f.inspect).toThrow("digest_mismatch");
  });
  it("rejects duplicate wire keys before Schema interpretation and enforces matrix capacity", () => {
    const f = setup();
    expect(() => f.preflight.inspect(Buffer.from('{"kind":"task_contract","kind":"gate_verdict"}'), f.bounds)).toThrow("duplicate_key");
    expect(() => f.preflight.inspect(Buffer.alloc(STRICT_JSON_LIMITS.bytes + 1), f.bounds)).toThrow("input_too_large");
    f.bounds[0]!.max_count = 501; expect(f.inspect).toThrow("capacity_exceeded");
  });
});
