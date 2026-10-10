export class StrictJsonError extends Error {
  constructor(readonly code: "invalid_json" | "duplicate_key" | "invalid_number" | "input_too_large") {
    super(code);
    this.name = "StrictJsonError";
  }
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const STRICT_JSON_LIMITS = Object.freeze({ bytes: 1024 * 1024, nodes: 50_000, depth: 100 });

// Bounded contract/asset wire profile: only nonnegative safe integer number
// tokens. Monetary amounts stay strings. No coercion, normalization or reviver.
export function parseStrictJson(bytes: Uint8Array): JsonValue {
  if (!(bytes instanceof Uint8Array)) throw new StrictJsonError("invalid_json");
  if (bytes.byteLength > STRICT_JSON_LIMITS.bytes) throw new StrictJsonError("input_too_large");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new StrictJsonError("invalid_json"); }
  let pos = 0, nodes = 0;
  const invalid = (): never => { throw new StrictJsonError("invalid_json"); };
  function space() { while (pos < text.length && /[\x20\t\n\r]/.test(text[pos]!)) pos++; }
  function string(): string {
    const start = pos++;
    let closed = false;
    while (pos < text.length) {
      const char = text[pos++]!;
      if (char === "\\") { pos++; continue; }
      if (char === '"') { closed = true; break; }
    }
    if (!closed) return invalid();
    let value: string;
    try { value = JSON.parse(text.slice(start, pos)) as string; } catch { return invalid(); }
    for (const char of value) {
      const point = char.codePointAt(0)!;
      if (point >= 0xd800 && point <= 0xdfff) return invalid();
    }
    return value;
  }
  function value(depth: number): JsonValue {
    if (++nodes > STRICT_JSON_LIMITS.nodes || depth > STRICT_JSON_LIMITS.depth) throw new StrictJsonError("input_too_large");
    space();
    const char = text[pos];
    if (char === '"') return string();
    if (char === "{") {
      pos++; space();
      const object: { [key: string]: JsonValue } = {};
      const keys = new Set<string>();
      if (text[pos] === "}") { pos++; return object; }
      while (pos < text.length) {
        if (text[pos] !== '"') return invalid();
        if (++nodes > STRICT_JSON_LIMITS.nodes) throw new StrictJsonError("input_too_large");
        const key = string();
        if (keys.has(key)) throw new StrictJsonError("duplicate_key");
        keys.add(key); space();
        if (text[pos++] !== ":") return invalid();
        // Define __proto__ as an own data property; never invoke its setter.
        Object.defineProperty(object, key, { value: value(depth + 1), enumerable: true, configurable: true, writable: true });
        space();
        const delimiter = text[pos++];
        if (delimiter === "}") return object;
        if (delimiter !== ",") return invalid();
        space();
      }
      return invalid();
    }
    if (char === "[") {
      pos++; space();
      const array: JsonValue[] = [];
      if (text[pos] === "]") { pos++; return array; }
      while (pos < text.length) {
        array.push(value(depth + 1)); space();
        const delimiter = text[pos++];
        if (delimiter === "]") return array;
        if (delimiter !== ",") return invalid();
      }
      return invalid();
    }
    for (const [token, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(token, pos)) { pos += token.length; return result; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(pos));
    if (!number) return invalid();
    pos += number[0].length;
    const parsed = Number(number[0]);
    if (!/^(0|[1-9]\d*)$/.test(number[0]) || !Number.isSafeInteger(parsed)) throw new StrictJsonError("invalid_number");
    return parsed;
  }
  const parsed = value(0);
  space();
  if (pos !== text.length) return invalid();
  return parsed;
}
