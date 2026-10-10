import { createRequire } from "node:module";
import { Ajv2020, type AnySchema, type Options, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createOfflineSchemaRegistry, type PinnedSchemaRef } from "./schema-registry.js";
import { sha256 } from "./input-snapshot.js";

const require = createRequire(import.meta.url);
const DIALECT = "https://json-schema.org/draft/2020-12/schema";
export const MAX_FROZEN_SCHEMAS = 64;
export const MAX_VALIDATION_BYTES = 1024 * 1024;
const MAX_JSON_NODES = 50_000;
const MAX_JSON_DEPTH = 100;

export class SchemaCompilationError extends Error {
  constructor(readonly code: "invalid_selection" | "duplicate_selection" | "unsupported_dialect" |
    "unsupported_async" | "compile_failed" | "not_frozen") {
    super(code);
    this.name = "SchemaCompilationError";
  }
}

const options = Object.freeze({
  strict: true,
  // The published v3 document uses partial conditional schemas. JSON Schema
  // permits these without repeating type/properties at each conditional node.
  strictTypes: false,
  strictRequired: false,
  allErrors: false,
  validateFormats: true,
  validateSchema: true,
  ownProperties: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  $data: false,
  logger: false,
  verbose: false,
  messages: false,
  inlineRefs: false,
} satisfies Options);

export const SCHEMA_COMPILER_PROFILE = Object.freeze({
  protocol: "onisall.schema-compiler.v1" as const,
  dialect: DIALECT,
  ajvVersion: require("ajv/package.json").version as string,
  formatsVersion: require("ajv-formats/package.json").version as string,
  options,
  formatsMode: "full" as const,
  formatKeywords: false,
  commentHandling: "ignored" as const,
  maxValidationBytes: MAX_VALIDATION_BYTES,
  maxJsonNodes: MAX_JSON_NODES,
  maxJsonDepth: MAX_JSON_DEPTH,
});

type Registry = ReturnType<typeof createOfflineSchemaRegistry>;
export type SchemaValidationResult = Readonly<
  { valid: true; code: "valid" } |
  { valid: false; code: "invalid_json" | "input_too_large" | "invalid_instance" | "validation_failed" }
>;

function tuple(ref: PinnedSchemaRef): string {
  return JSON.stringify([ref.registry_key, ref.revision, ref.sha256]);
}

function checkCompilerDialect(schema: unknown) {
  const stack = [schema];
  while (stack.length) {
    const value = stack.pop();
    if (value !== null && typeof value === "object") {
      // Match the registry's deliberately conservative whole-document policy.
      // No async promises, custom vocabulary, or alternate dialect resource.
      if (Object.hasOwn(value, "$async")) throw new SchemaCompilationError("unsupported_async");
      if (Object.hasOwn(value, "$schema") && (value as Record<string, unknown>).$schema !== DIALECT) {
        throw new SchemaCompilationError("unsupported_dialect");
      }
      stack.push(...Object.values(value));
    }
  }
}

function parseInstance(bytes: Uint8Array): { value: unknown } | SchemaValidationResult {
  if (bytes.byteLength > MAX_VALIDATION_BYTES) return { valid: false, code: "input_too_large" };
  let value: unknown;
  try {
    // JSON wire bytes have no BOM. Do not silently discard one while decoding.
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return { valid: false, code: "invalid_json" };
  }
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++nodes > MAX_JSON_NODES || item.depth > MAX_JSON_DEPTH) return { valid: false, code: "input_too_large" };
    if (typeof item.value === "number" && !Number.isFinite(item.value)) return { valid: false, code: "invalid_json" };
    if (item.value !== null && typeof item.value === "object") {
      for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1 });
    }
  }
  return { value };
}

// Trusted deployment code selects registered assets. No HTTP registration,
// loader, compilation callback, arbitrary JS instance, or execution grant.
// Compile synchronously at preparation time, never from model-provided schemas.
export function freezeSchemaValidators(registry: Registry, refs: readonly PinnedSchemaRef[]) {
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > MAX_FROZEN_SCHEMAS) {
    throw new SchemaCompilationError("invalid_selection");
  }
  const selected = refs.map(ref => registry.resolve(ref));
  selected.sort((a, b) => Buffer.compare(Buffer.from(tuple(a.ref)), Buffer.from(tuple(b.ref))));
  const validators = new Map<string, ValidateFunction>();
  for (const { ref, schema } of selected) {
    const key = tuple(ref);
    if (validators.has(key)) throw new SchemaCompilationError("duplicate_selection");
    checkCompilerDialect(schema);
    try {
      // One namespace per pinned document: an identical $id in another
      // revision cannot substitute a cached schema. No loadSchema is provided.
      const ajv = new Ajv2020(options);
      (addFormats as unknown as (instance: Ajv2020, config: unknown) => void)(ajv, { mode: "full", keywords: false });
      const validate = ajv.compile(schema as AnySchema);
      if ("$async" in validate) throw new SchemaCompilationError("unsupported_async");
      validators.set(key, validate);
    } catch (error) {
      if (error instanceof SchemaCompilationError) throw error;
      // Ajv exceptions may contain schema values or generated source.
      throw new SchemaCompilationError("compile_failed");
    }
  }
  const manifest = Object.freeze({
    protocol: "onisall.frozen-schema-set.v1" as const,
    compiler: SCHEMA_COMPILER_PROFILE,
    schemas: Object.freeze(selected.map(({ ref }) => ref)),
  });
  // v1 uses this exact fixed-key JSON projection and UTF-8 tuple ordering.
  // This is a schema-set fingerprint, not TaskContract/acceptance/JCS hashing.
  const manifestSha256 = sha256(Buffer.from(JSON.stringify(manifest), "utf8"));
  return Object.freeze({
    manifest,
    manifestSha256,
    validate(ref: PinnedSchemaRef, bytes: Uint8Array): SchemaValidationResult {
      const validate = validators.get(tuple(ref));
      if (!validate) throw new SchemaCompilationError("not_frozen");
      const input = parseInstance(bytes);
      if (!("value" in input)) return Object.freeze(input);
      try {
        return Object.freeze(validate(input.value) === true
          ? { valid: true, code: "valid" }
          : { valid: false, code: "invalid_instance" });
      } catch {
        // Recursive refs or other validator failures never produce a pass.
        return Object.freeze({ valid: false, code: "validation_failed" });
      }
    },
  });
}
