import { z } from "zod";
import { sha256 } from "./input-snapshot.js";

// Internal preparation objects only. Raw JSON and published contracts must pass
// their own wire/Schema validation before reaching this domain boundary.
export const boundedText = (max: number) => z.string().min(1).max(max).refine(value =>
  value.trim().length > 0 && [...value].every(char => {
    const point = char.codePointAt(0)!;
    return point < 0xd800 || point > 0xdfff;
  }));
export const fixedRevision = boundedText(160).refine(value => !["latest", "main", "master", "HEAD"].includes(value));
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const checkReference = z.object({
  check_id: boundedText(120), revision: fixedRevision, validator_sha256: digest,
}).strict();
export const targetKind = z.enum(["artifact", "artifact_set", "source", "claim"]);
export const checkDescriptorSchema = z.object({
  check: checkReference,
  target_kinds: z.array(targetKind).min(1).max(4),
  evidence_mode: z.enum(["machine", "authenticated_human"]),
}).strict();
export type RequiredCheck = z.infer<typeof checkReference>;
export type CheckDescriptor = z.infer<typeof checkDescriptorSchema>;
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

export class CheckPreparationError extends Error {
  constructor(readonly code: "invalid_input" | "digest_mismatch" | "revision_conflict" |
    "not_registered" | "duplicate_input" | "schema_not_frozen" | "invalid_bounds" |
    "capacity_exceeded" | "unexpected_artifact" | "empty_targets" | "matrix_mismatch") {
    super(code);
    this.name = "CheckPreparationError";
  }
}

export function parsePreparation<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new CheckPreparationError("invalid_input");
  return result.data;
}

export function freezePreparation<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezePreparation(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

// Fixed ASCII-key, safe-integer preparation projections. Not a raw JSON parser,
// acceptance hash, artifact-set hash, or a general JCS implementation.
export function preparationJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    if ([...value].some(char => { const p = char.codePointAt(0)!; return p >= 0xd800 && p <= 0xdfff; })) {
      throw new CheckPreparationError("invalid_input");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(preparationJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf8);
    if (keys.some(key => !/^[\x20-\x7e]+$/.test(key))) throw new CheckPreparationError("invalid_input");
    return `{${keys.map(key => `${JSON.stringify(key)}:${preparationJson(record[key])}`).join(",")}}`;
  }
  throw new CheckPreparationError("invalid_input");
}

export function preparationHash(value: unknown): string {
  return sha256(Buffer.from(preparationJson(value), "utf8"));
}

export function checkIdentity(check: Pick<RequiredCheck, "check_id" | "revision">): string {
  return JSON.stringify([check.check_id, check.revision]);
}

// Trusted deployment assets only; no command execution, imports, path resolver,
// network access or model-accessible registration. The bytes are hashed, never run.
export function createOfflineCheckRegistry(entries: readonly {
  descriptor: CheckDescriptor; validatorBytes: Uint8Array;
}[]) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 500) {
    throw new CheckPreparationError("invalid_input");
  }
  const catalog = new Map<string, DeepReadonly<CheckDescriptor>>();
  for (const entry of entries) {
    const spec = parsePreparation(checkDescriptorSchema, entry.descriptor);
    if (!(entry.validatorBytes instanceof Uint8Array) || entry.validatorBytes.byteLength === 0 ||
        entry.validatorBytes.byteLength > 1024 * 1024) throw new CheckPreparationError("invalid_input");
    if (sha256(Buffer.from(entry.validatorBytes)) !== spec.check.validator_sha256) {
      throw new CheckPreparationError("digest_mismatch");
    }
    if (new Set(spec.target_kinds).size !== spec.target_kinds.length) throw new CheckPreparationError("duplicate_input");
    spec.target_kinds.sort(compareUtf8);
    const key = checkIdentity(spec.check);
    const previous = catalog.get(key);
    if (previous && preparationJson(previous) !== preparationJson(spec)) throw new CheckPreparationError("revision_conflict");
    catalog.set(key, freezePreparation(spec));
  }
  return Object.freeze({
    resolve(reference: RequiredCheck): DeepReadonly<CheckDescriptor> {
      const check = parsePreparation(checkReference, reference);
      const found = catalog.get(checkIdentity(check));
      if (!found) throw new CheckPreparationError("not_registered");
      if (found.check.validator_sha256 !== check.validator_sha256) throw new CheckPreparationError("digest_mismatch");
      return found;
    },
  });
}
