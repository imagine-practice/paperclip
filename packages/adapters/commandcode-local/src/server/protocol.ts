export interface RawUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
export interface CommandCodeResult { subtype: "success" | "error" | "max_turns"; sessionId: string | null; usage: RawUsage; durationMs: number; finalText: string }
export const MAX_LINE = 256 * 1024;
export const MAX_OUTPUT = 4 * 1024 * 1024;
const TOKEN_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];

export function readUsage(value: unknown): RawUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!TOKEN_KEYS.every((key) => typeof raw[key] === "number" && Number.isSafeInteger(raw[key]) && raw[key] >= 0)) return null;
  return Object.fromEntries(TOKEN_KEYS.map((key) => [key, raw[key]])) as unknown as RawUsage;
}

export function mapUsage(raw: RawUsage | null) {
  if (!raw || raw.cacheWriteTokens !== 0 || raw.cacheReadTokens > raw.inputTokens) return undefined;
  return { inputTokens: raw.inputTokens - raw.cacheReadTokens, outputTokens: raw.outputTokens,
    cachedInputTokens: raw.cacheReadTokens, cacheWriteTokens: 0 };
}

function checkDepth(text: string) {
  let depth = 0, quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      if (++depth > 32) throw new Error("commandcode_json_depth");
    } else if (char === "}" || char === "]") depth--;
  }
}

export class ResultStream {
  decoder = new TextDecoder("utf-8", { fatal: true });
  pending = "";
  bytes = 0;
  events = 0;
  
  result: CommandCodeResult | null = null;
  eventCounts = new Map<string, number>();
  
  reportedModels = new Set<string>();

  push(chunk: Buffer) {
    this.bytes += chunk.length;
    if (this.bytes > MAX_OUTPUT) throw new Error("commandcode_output_limit");
    try { this.pending += this.decoder.decode(chunk, { stream: true }); }
    catch { throw new Error("commandcode_invalid_utf8"); }
    let newline;
    while ((newline = this.pending.indexOf("\n")) >= 0) {
      this.line(this.pending.slice(0, newline));
      this.pending = this.pending.slice(newline + 1);
    }
    if (Buffer.byteLength(this.pending) > MAX_LINE) throw new Error("commandcode_line_limit");
  }

  line(text: string) {
    if (!text.trim()) return;
    if (Buffer.byteLength(text) > MAX_LINE) throw new Error("commandcode_line_limit");
    if (this.result) throw new Error("commandcode_output_after_result");
    checkDepth(text);
    let value;
    try { value = JSON.parse(text); } catch { throw new Error("commandcode_invalid_json"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("commandcode_invalid_record");
    if (value.type === "event") {
      const kind = value.event?.type;
      if (typeof kind !== "string" || !/^[a-z_]{1,80}$/.test(kind)) throw new Error("commandcode_invalid_event");
      if (++this.events > 10000) throw new Error("commandcode_event_limit");
      if (!this.eventCounts.has(kind) && this.eventCounts.size >= 128) throw new Error("commandcode_event_kind_limit");
      this.eventCounts.set(kind, (this.eventCounts.get(kind) ?? 0) + 1);
      if ((kind === "model_request_start" || kind === "model_request_end") &&
          typeof value.event.model === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(value.event.model)) {
        if (this.reportedModels.size >= 16 && !this.reportedModels.has(value.event.model)) throw new Error("commandcode_model_count_limit");
        this.reportedModels.add(value.event.model);
      }
      return;
    }
    if (value.type !== "result" || !["success", "error", "max_turns"].includes(value.subtype)) {
      throw new Error("commandcode_invalid_result");
    }
    const usage = readUsage(value.usage);
    if (!usage || typeof value.finalText !== "string" || !Number.isFinite(value.durationMs) || value.durationMs < 0) {
      throw new Error("commandcode_invalid_result_fields");
    }
    if (usage.cacheReadTokens > usage.inputTokens) throw new Error("commandcode_inconsistent_usage");
    if (value.sessionId !== undefined && (typeof value.sessionId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(value.sessionId))) {
      throw new Error("commandcode_invalid_session");
    }
    // Error strings and arbitrary CLI fields are deliberately not persisted.
    this.result = { subtype: value.subtype, sessionId: value.sessionId ?? null,
      usage, durationMs: value.durationMs, finalText: value.finalText.slice(0, 16000) };
  }

  finish() {
    try { this.pending += this.decoder.decode(); }
    catch { throw new Error("commandcode_truncated_utf8"); }
    // NDJSON terminal records must be newline-terminated; a partial tail is ambiguous.
    if (this.pending.trim()) throw new Error("commandcode_truncated_output");
    if (!this.result) throw new Error("commandcode_missing_result");
    return this.result;
  }
}
