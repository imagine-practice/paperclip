import { sha256 } from "./input-snapshot.js";

export interface PinnedSchemaRef {
  readonly registry_key: string;
  readonly revision: string;
  readonly sha256: string;
}

export class SchemaRegistryError extends Error {
  constructor(readonly code: "invalid_reference" | "invalid_schema" | "unsupported_reference" |
    "missing_local_reference" | "schema_too_large" | "digest_mismatch" |
    "revision_conflict" | "not_registered") {
    super(code);
    this.name = "SchemaRegistryError";
  }
}

const MAX_SCHEMA_BYTES = 1024 * 1024;
const MAX_SCHEMA_NODES = 50000;
const MAX_SCHEMA_DEPTH = 100;
type JsonObject = Record<string, unknown>;

function identity(ref: PinnedSchemaRef): string {
  if (!ref || typeof ref.registry_key !== "string" || !ref.registry_key.trim() ||
      ref.registry_key.length > 200 || typeof ref.revision !== "string" ||
      !ref.revision.trim() || ref.revision.length > 160 ||
      ["latest", "main", "master", "HEAD"].includes(ref.revision) ||
      typeof ref.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(ref.sha256)) {
    throw new SchemaRegistryError("invalid_reference");
  }
  return JSON.stringify([ref.registry_key, ref.revision]);
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseOfflineSchema(bytes: Buffer): unknown {
  let root: unknown;
  try {
    root = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new SchemaRegistryError("invalid_schema");
  }
  if (typeof root !== "boolean" && !object(root)) throw new SchemaRegistryError("invalid_schema");
  // This prepares a closed document, not a JSON Schema validator. Compilation is
  // a separate gate. No loader, URL resolver, executable plugin or filesystem API.
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  const references: string[] = [];
  let count = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++count > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) {
      throw new SchemaRegistryError("schema_too_large");
    }
    if (Array.isArray(value)) {
      for (const child of value) stack.push({ value: child, depth: depth + 1 });
    } else if (object(value)) {
      for (const [key, child] of Object.entries(value)) {
        // Nested schema resources and dynamic anchors need a richer offline
        // resolver. Reject them until explicitly supported instead of guessing.
        if (["$dynamicRef", "$recursiveRef", "$dynamicAnchor", "$recursiveAnchor", "$anchor"].includes(key) ||
            (key === "$id" && depth > 0)) {
          throw new SchemaRegistryError("unsupported_reference");
        }
        if (key === "$ref") {
          if (typeof child !== "string" || (child !== "#" && !child.startsWith("#/"))) {
            throw new SchemaRegistryError("unsupported_reference");
          }
          references.push(child);
        }
        stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
  for (const ref of references) {
    if (ref === "#") continue;
    let fragment: string;
    try { fragment = decodeURIComponent(ref.slice(2)); }
    catch { throw new SchemaRegistryError("unsupported_reference"); }
    let target: unknown = root;
    for (const component of fragment.split("/")) {
      if (/~(?![01])/u.test(component)) throw new SchemaRegistryError("unsupported_reference");
      const token = component.replaceAll("~1", "/").replaceAll("~0", "~");
      if ((!object(target) && !Array.isArray(target)) || !Object.hasOwn(target, token)) {
        throw new SchemaRegistryError("missing_local_reference");
      }
      target = (target as JsonObject)[token];
    }
    if (typeof target !== "boolean" && !object(target)) throw new SchemaRegistryError("invalid_schema");
  }
  return root;
}

// Construct once from trusted, pinned deployment assets. Never expose registration
// to model output. Resolving bytes conveys neither business approval nor a grant.
export function createOfflineSchemaRegistry(entries: readonly { ref: PinnedSchemaRef; bytes: Uint8Array }[]) {
  const catalog = new Map<string, { ref: PinnedSchemaRef; bytes: Buffer }>();
  for (const entry of entries) {
    const key = identity(entry.ref);
    if (entry.bytes.byteLength > MAX_SCHEMA_BYTES) throw new SchemaRegistryError("schema_too_large");
    const bytes = Buffer.from(entry.bytes);
    if (sha256(bytes) !== entry.ref.sha256) throw new SchemaRegistryError("digest_mismatch");
    parseOfflineSchema(bytes);
    const existing = catalog.get(key);
    if (existing && !existing.bytes.equals(bytes)) throw new SchemaRegistryError("revision_conflict");
    catalog.set(key, { ref: Object.freeze({ registry_key: entry.ref.registry_key,
      revision: entry.ref.revision, sha256: entry.ref.sha256 }), bytes });
  }
  return Object.freeze({
    resolve(ref: PinnedSchemaRef) {
      const entry = catalog.get(identity(ref));
      if (!entry) throw new SchemaRegistryError("not_registered");
      if (entry.ref.sha256 !== ref.sha256) throw new SchemaRegistryError("digest_mismatch");
      // Fresh copies prevent consumers from changing the next resolution.
      return { ref: entry.ref, bytes: Buffer.from(entry.bytes), schema: parseOfflineSchema(entry.bytes) };
    },
    list(): readonly PinnedSchemaRef[] {
      return Object.freeze([...catalog.values()].map((entry) => entry.ref));
    },
  });
}
