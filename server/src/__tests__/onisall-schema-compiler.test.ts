import { describe, expect, it } from "vitest";
import { createOfflineSchemaRegistry } from "../services/onisall/schema-registry.js";
import { freezeSchemaValidators, MAX_FROZEN_SCHEMAS, MAX_VALIDATION_BYTES,
  SCHEMA_COMPILER_PROFILE } from "../services/onisall/schema-compiler.js";
import { sha256 } from "../services/onisall/input-snapshot.js";

function entry(schema: unknown, revision = "1", registry_key = "example") {
  const bytes = Buffer.from(JSON.stringify(schema));
  return { bytes, ref: { registry_key, revision, sha256: sha256(bytes) } };
}
function setup(schema: unknown) {
  const item = entry(schema);
  return { item, frozen: freezeSchemaValidators(createOfflineSchemaRegistry([item]), [item.ref]) };
}
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("OnisAll offline Schema compiler", () => {
  it("compiles local refs and enforces formats and 2020-12 unevaluated fields", () => {
    const { item, frozen } = setup({ $schema: SCHEMA_COMPILER_PROFILE.dialect,
      $defs: { id: { type: "string", format: "uuid" } }, type: "object",
      allOf: [{ properties: { id: { $ref: "#/$defs/id" } }, required: ["id"] }], unevaluatedProperties: false });
    const id = "00000000-0000-0000-0000-000000000001";
    expect(frozen.validate(item.ref, json({ id })).valid).toBe(true);
    expect(frozen.validate(item.ref, json({ id: "invalid" })).valid).toBe(false);
    expect(frozen.validate(item.ref, json({ id, extra: true })).valid).toBe(false);
  });

  it.each([
    [{ type: "strnig" }, "compile_failed"],
    [{ type: "string", format: "unregistered" }, "compile_failed"],
    [{ minLenght: 3 }, "compile_failed"],
    [{ type: "string", pattern: "[" }, "compile_failed"],
    [{ $async: true }, "unsupported_async"],
    [{ $defs: { sub: { $async: false } } }, "unsupported_async"],
    [{ $schema: "http://json-schema.org/draft-07/schema#" }, "unsupported_dialect"],
    [{ $ref: "https://invalid.example/private" }, "unsupported_reference"],
    [{ $ref: "file:///private" }, "unsupported_reference"],
    [{ $ref: "urn:other:schema" }, "unsupported_reference"],
    [{ $ref: "#/$defs/missing" }, "missing_local_reference"],
    [{ $dynamicRef: "#" }, "unsupported_reference"],
    [{ $defs: { sub: { $id: "nested" } } }, "unsupported_reference"],
  ])("rejects invalid or unsupported rules %#", (schema, code) => {
    expect(() => setup(schema)).toThrow(String(code));
  });

  it("keeps schema registration identity and selection exact", () => {
    const item = entry(true), registry = createOfflineSchemaRegistry([item]);
    expect(() => freezeSchemaValidators(registry, [])).toThrow("invalid_selection");
    expect(() => freezeSchemaValidators(registry, Array(MAX_FROZEN_SCHEMAS + 1).fill(item.ref))).toThrow("invalid_selection");
    expect(() => freezeSchemaValidators(registry, [item.ref, item.ref])).toThrow("duplicate_selection");
    expect(() => freezeSchemaValidators(registry, [{ ...item.ref, revision: "2" }])).toThrow("not_registered");
    expect(() => freezeSchemaValidators(registry, [{ ...item.ref, sha256: "0".repeat(64) }])).toThrow("digest_mismatch");
    const frozen = freezeSchemaValidators(registry, [item.ref]);
    expect(() => frozen.validate({ ...item.ref, sha256: "0".repeat(64) }, json({}))).toThrow("not_frozen");
  });

  it("fingerprints rules and compiler settings deterministically and isolates same-id revisions", () => {
    const first = entry({ $id: "urn:onisall:example", type: "string" });
    const second = entry({ $id: "urn:onisall:example", type: "number" }, "2");
    const registry = createOfflineSchemaRegistry([first, second]);
    const frozen = freezeSchemaValidators(registry, [second.ref, first.ref]);
    expect(frozen.manifestSha256).toBe(freezeSchemaValidators(registry, [first.ref, second.ref]).manifestSha256);
    expect(frozen.manifestSha256).toBe(sha256(Buffer.from(JSON.stringify(frozen.manifest))));
    expect(frozen.manifest.compiler.ajvVersion).toBe("8.20.0");
    expect(frozen.manifest.compiler.formatsVersion).toBe("3.0.1");
    expect(frozen.validate(first.ref, json("one")).valid).toBe(true);
    expect(frozen.validate(second.ref, json("one")).valid).toBe(false);
    expect(frozen.validate(second.ref, json(1)).valid).toBe(true);
    expect(frozen.manifestSha256).not.toBe(freezeSchemaValidators(registry, [first.ref]).manifestSha256);
    const changed = entry({ type: "boolean" });
    expect(freezeSchemaValidators(createOfflineSchemaRegistry([changed]), [changed.ref]).manifestSha256)
      .not.toBe(freezeSchemaValidators(registry, [first.ref]).manifestSha256);
    const version = entry({ $id: "urn:onisall:example", type: "string" }, "3");
    expect(freezeSchemaValidators(createOfflineSchemaRegistry([version]), [version.ref]).manifestSha256)
      .not.toBe(freezeSchemaValidators(registry, [first.ref]).manifestSha256);
  });

  it("freezes metadata and prevents input/registry mutation from changing validation", () => {
    const item = entry({ type: "string" });
    const originalRef = { ...item.ref };
    const registry = createOfflineSchemaRegistry([item]);
    const refs = [item.ref];
    const frozen = freezeSchemaValidators(registry, refs);
    item.bytes.fill(0); item.ref.revision = "changed"; refs.length = 0;
    const resolved = registry.resolve(originalRef);
    resolved.bytes.fill(0); (resolved.schema as Record<string, unknown>).type = "number";
    expect(Object.isFrozen(frozen)).toBe(true);
    for (const object of [frozen.manifest, frozen.manifest.schemas, frozen.manifest.schemas[0],
      frozen.manifest.compiler, frozen.manifest.compiler.options]) expect(Object.isFrozen(object)).toBe(true);
    expect(frozen.validate(originalRef, json("valid"))).toEqual({ valid: true, code: "valid" });
    expect(frozen.validate(originalRef, json(3))).toEqual({ valid: false, code: "invalid_instance" });
  });

  it("does not coerce values, insert defaults or strip additional fields", () => {
    const { item, frozen } = setup({ type: "object", required: ["count"], additionalProperties: false,
      properties: { count: { type: "integer", default: 1 } } });
    for (const value of [{}, { count: "1" }, { count: 1, extra: "secret" }]) {
      const bytes = json(value), before = Buffer.from(bytes);
      expect(frozen.validate(item.ref, bytes)).toEqual({ valid: false, code: "invalid_instance" });
      expect(bytes.equals(before)).toBe(true);
    }
    expect(frozen.validate(item.ref, json({ count: 1 })).valid).toBe(true);
  });

  it.each([Buffer.from("{"), Buffer.from([0xc3, 0x28]), Buffer.from("\ufeff{}"), Buffer.from("1e999"), Buffer.alloc(0)])(
    "rejects invalid JSON wire bytes %#", bytes => {
      const { item, frozen } = setup(true);
      expect(frozen.validate(item.ref, bytes)).toEqual({ valid: false, code: "invalid_json" });
    });

  it("bounds JSON bytes, node count and depth, including boolean schemas", () => {
    const { item, frozen } = setup(true);
    for (const bytes of [Buffer.alloc(MAX_VALIDATION_BYTES + 1), json(Array(50_001).fill(0)),
      Buffer.from("[".repeat(102) + "0" + "]".repeat(102))]) {
      expect(frozen.validate(item.ref, bytes)).toEqual({ valid: false, code: "input_too_large" });
    }
    expect(frozen.validate(item.ref, Buffer.from('"' + "x".repeat(MAX_VALIDATION_BYTES - 2) + '"')).valid).toBe(true);
    const deny = setup(false);
    expect(deny.frozen.validate(deny.item.ref, json(null))).toEqual({ valid: false, code: "invalid_instance" });
  });

  it("does not expose schema/data text, error paths or stale validator errors", () => {
    const { item, frozen } = setup({ type: "object", additionalProperties: false });
    const result = frozen.validate(item.ref, json({ "private-field": "private-value" }));
    expect(result).toEqual({ valid: false, code: "invalid_instance" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(frozen.validate(item.ref, json({}))).toEqual({ valid: true, code: "valid" });
    expect(result).toEqual({ valid: false, code: "invalid_instance" });
    try { setup({ "private-schema-keyword": "private-schema-value" }); }
    catch (error) { expect((error as Error).message).toBe("compile_failed"); }
  });

  it("turns recursive runtime failures into a refusal", () => {
    const { item, frozen } = setup({ $ref: "#" });
    expect(frozen.validate(item.ref, json({}))).toEqual({ valid: false, code: "validation_failed" });
  });
});

