import { createHash } from "node:crypto";

// Byte-level preparation only. Callers still enforce scope, retention and admission.
export const INPUT_SNAPSHOT_PROTOCOL = "onisall.input-text.v1" as const;
export const MAX_INPUT_BYTES = 1024 * 1024;

export class InputSnapshotError extends Error {
  constructor(readonly code: "empty_input" | "input_too_large" | "invalid_utf8" |
    "unsupported_text" | "hash_mismatch" | "invalid_locator") {
    super(code);
    this.name = "InputSnapshotError";
  }
}

export interface InputLine {
  readonly line: number;
  readonly byteStart: number;
  readonly byteEnd: number;
}

export interface InputTextSnapshot {
  readonly protocol: typeof INPUT_SNAPSHOT_PROTOCOL;
  readonly sha256: string;
  readonly byteSize: number;
  readonly encoding: "utf-8";
  readonly hasBom: boolean;
  readonly lineCount: number;
  readonly lines: readonly InputLine[];
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decode(bytes: Uint8Array): string {
  try {
    // Preserve a BOM: hashes and offsets describe the original bytes.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new InputSnapshotError("invalid_utf8");
  }
}

export function captureInputText(bytes: Uint8Array): InputTextSnapshot {
  if (bytes.byteLength === 0) throw new InputSnapshotError("empty_input");
  if (bytes.byteLength > MAX_INPUT_BYTES) throw new InputSnapshotError("input_too_large");
  const owned = Buffer.from(bytes);
  const text = decode(owned);
  if (text.includes("\0")) throw new InputSnapshotError("unsupported_text");
  const lines: InputLine[] = [];
  let start = 0;
  for (let offset = 0; offset < owned.length; offset++) {
    if (owned[offset] !== 10 && owned[offset] !== 13) continue;
    lines.push(Object.freeze({ line: lines.length + 1, byteStart: start, byteEnd: offset }));
    if (owned[offset] === 13 && owned[offset + 1] === 10) offset++;
    start = offset + 1;
  }
  // A final delimiter terminates its preceding line; it does not invent a line.
  if (start < owned.length) {
    lines.push(Object.freeze({ line: lines.length + 1, byteStart: start, byteEnd: owned.length }));
  }
  return Object.freeze({
    protocol: INPUT_SNAPSHOT_PROTOCOL,
    sha256: sha256(owned),
    byteSize: owned.length,
    encoding: "utf-8",
    hasBom: owned[0] === 0xef && owned[1] === 0xbb && owned[2] === 0xbf,
    lineCount: lines.length,
    lines: Object.freeze(lines),
  });
}

export function readInputLines(bytes: Uint8Array, expectedHash: string, first: number, last: number): string {
  // Rebuild offsets from verified bytes; never trust a caller-supplied line index.
  const owned = Buffer.from(bytes);
  const snapshot = captureInputText(owned);
  if (snapshot.sha256 !== expectedHash) throw new InputSnapshotError("hash_mismatch");
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) ||
      first < 1 || last < first || last > snapshot.lineCount) {
    throw new InputSnapshotError("invalid_locator");
  }
  return decode(owned.subarray(snapshot.lines[first - 1].byteStart, snapshot.lines[last - 1].byteEnd));
}
