import { describe, expect, it } from "vitest";
import { captureInputText, readInputLines, sha256, MAX_INPUT_BYTES } from "../services/onisall/input-snapshot.js";
import { createOfflineSchemaRegistry } from "../services/onisall/schema-registry.js";
import { createOnisallIntakeDraftSchema } from "@paperclipai/shared";

describe("OnisAll input bytes", () => {
  it.each(["a\nb\n", "a\r\nb\r\n", "a\rb\r"])("preserves delimiters in %j", (text) => {
    const bytes = Buffer.from(text);
    const snapshot = captureInputText(bytes);
    expect(snapshot.lineCount).toBe(2);
    expect(readInputLines(bytes, snapshot.sha256, 1, 2)).toBe(text.replace(/(?:\r\n|\r|\n)$/, ""));
  });
  it("preserves BOM and multibyte offsets", () => {
    const bytes = Buffer.from("\ufeff甲\r\n乙");
    const snapshot = captureInputText(bytes);
    expect(snapshot.hasBom).toBe(true);
    expect(snapshot.lines).toEqual([{ line: 1, byteStart: 0, byteEnd: 6 }, { line: 2, byteStart: 8, byteEnd: 11 }]);
    expect(readInputLines(bytes, snapshot.sha256, 1, 1)).toBe("\ufeff甲");
  });
  it.each([
    [Buffer.alloc(0), "empty_input"], [Buffer.from([0xc3, 0x28]), "invalid_utf8"],
    [Buffer.from("a\0b"), "unsupported_text"], [Buffer.alloc(MAX_INPUT_BYTES + 1), "input_too_large"],
  ])("rejects invalid input %#", (bytes, code) => {
    expect(() => captureInputText(bytes as Buffer)).toThrow(String(code));
  });
  it("enforces hash and line ranges", () => {
    const bytes = Buffer.from("a\nb");
    expect(() => readInputLines(bytes, "0".repeat(64), 1, 1)).toThrow("hash_mismatch");
    for (const [first, last] of [[0, 1], [2, 1], [1, 3], [1.5, 2]]) {
      expect(() => readInputLines(bytes, sha256(bytes), first!, last!)).toThrow("invalid_locator");
    }
  });
  it("rejects published authority fields in a draft request", () => {
    const input = { requestKey: "input-1", goal: "prepare", sourceLabel: "source", contentBase64: "YQ==" };
    expect(createOnisallIntakeDraftSchema.safeParse(input).success).toBe(true);
    for (const field of ["businessKey", "companyId", "status", "caseId", "contractId", "grant"]) {
      expect(createOnisallIntakeDraftSchema.safeParse({ ...input, [field]: "injected" }).success).toBe(false);
    }
  });
});

describe("OnisAll offline registry", () => {
  function entry(schema: unknown, revision = "1") {
    const bytes = Buffer.from(JSON.stringify(schema));
    return { bytes, ref: { registry_key: "local/example", revision, sha256: sha256(bytes) } };
  }
  it("returns independent byte and parsed copies", () => {
    const item = entry({ type: "object", $defs: { "a/b": { type: "string" } }, $ref: "#/$defs/a~1b" });
    const registry = createOfflineSchemaRegistry([item]);
    item.bytes.fill(0);
    const first = registry.resolve(item.ref);
    first.bytes.fill(0);
    (first.schema as Record<string, unknown>).type = "number";
    expect(registry.resolve(item.ref).schema).toMatchObject({ type: "object" });
    expect(sha256(registry.resolve(item.ref).bytes)).toBe(item.ref.sha256);
  });
  it.each([
    [{ $ref: "https://invalid.example/schema" }, "unsupported_reference"],
    [{ $ref: "file:///private/schema" }, "unsupported_reference"],
    [{ $ref: "#/$defs/missing" }, "missing_local_reference"],
    [{ $dynamicRef: "#node" }, "unsupported_reference"],
    [{ $defs: { node: { $id: "child" } } }, "unsupported_reference"],
    [{ $ref: "#/type", type: "object" }, "invalid_schema"],
  ])("rejects unresolved or unsupported schemas", (schema, code) => {
    expect(() => createOfflineSchemaRegistry([entry(schema)])).toThrow(String(code));
  });
  it("rejects conflicting revisions, digest mismatches and unregistered refs", () => {
    const item = entry(true);
    expect(() => createOfflineSchemaRegistry([item, entry(false)])).toThrow("revision_conflict");
    const registry = createOfflineSchemaRegistry([item]);
    expect(() => registry.resolve({ ...item.ref, sha256: "0".repeat(64) })).toThrow("digest_mismatch");
    expect(() => registry.resolve({ ...item.ref, revision: "2" })).toThrow("not_registered");
    expect(() => createOfflineSchemaRegistry([{ ...item, bytes: Buffer.from("false") }])).toThrow("digest_mismatch");
    expect(() => createOfflineSchemaRegistry([entry(true, "latest")])).toThrow("invalid_reference");
  });
});
