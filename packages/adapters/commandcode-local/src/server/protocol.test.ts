import { describe, expect, it } from "vitest";
import { ResultStream, MAX_LINE, MAX_OUTPUT, mapUsage, readUsage } from "./protocol.js";

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 6, cacheWriteTokens: 0 };
const result = { type: "result", subtype: "success", sessionId: "session123", usage, durationMs: 12, finalText: "完成" };
const line = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");

describe("CommandCode protocol", () => {
  it("decodes split UTF-8 and counts events without accumulating their usage", () => {
    const stream = new ResultStream();
    const bytes = Buffer.concat([line({ type: "event", event: { type: "model_request_end", model: "deepseek/deepseek-v4.1-flash", usage } }), line(result)]);
    for (const byte of bytes) stream.push(Buffer.from([byte]));
    expect(stream.finish()).toMatchObject({ finalText: "完成", usage });
    expect([...stream.eventCounts]).toEqual([["model_request_end", 1]]);
    expect([...stream.reportedModels]).toEqual(["deepseek/deepseek-v4.1-flash"]);
  });
  it("maps final usage with cache reads counted once and refuses unqualified writes", () => {
    expect(mapUsage(usage)).toEqual({ inputTokens: 4, outputTokens: 2, cachedInputTokens: 6, cacheWriteTokens: 0 });
    expect(mapUsage({ ...usage, cacheWriteTokens: 1 })).toBeUndefined();
    expect(mapUsage({ ...usage, cacheReadTokens: 11 })).toBeUndefined();
    expect(mapUsage(null)).toBeUndefined();
    for (const invalid of [null, [], {}, { ...usage, inputTokens: -1 }, { ...usage, inputTokens: 0.5 },
      { ...usage, inputTokens: Number.MAX_SAFE_INTEGER + 1 }]) expect(readUsage(invalid)).toBeNull();
  });
  it.each(["error", "max_turns"])("retains terminal subtype %s", subtype => {
    const stream = new ResultStream(); stream.push(line({ ...result, subtype }));
    expect(stream.finish().subtype).toBe(subtype);
  });
  it.each([
    [Buffer.from("not-json\n"), "commandcode_invalid_json"],
    [line(null), "commandcode_invalid_record"],
    [line({ type: "event", event: { type: "untrusted message" } }), "commandcode_invalid_event"],
    [line({ ...result, subtype: "approved" }), "commandcode_invalid_result"],
    [line({ ...result, sessionId: "bad" }), "commandcode_invalid_session"],
    [line({ ...result, usage: { ...usage, cacheReadTokens: 11 } }), "commandcode_inconsistent_usage"],
    [line({ ...result, durationMs: -1 }), "commandcode_invalid_result_fields"],
    [Buffer.from([0xc3, 0x28]), "commandcode_invalid_utf8"],
    [Buffer.alloc(MAX_OUTPUT + 1), "commandcode_output_limit"],
    [Buffer.from("x".repeat(MAX_LINE + 1)), "commandcode_line_limit"],
    [Buffer.from("[".repeat(33) + "0" + "]".repeat(33) + "\n"), "commandcode_json_depth"],
  ])("refuses malformed output %#", (bytes, code) => {
    expect(() => new ResultStream().push(bytes as Buffer)).toThrow(String(code));
  });
  it("rejects duplicate terminal output and incomplete tails", () => {
    const stream = new ResultStream(); stream.push(line(result));
    expect(() => stream.push(line(result))).toThrow("commandcode_output_after_result");
    const tail = new ResultStream(); tail.push(Buffer.from(JSON.stringify(result)));
    expect(() => tail.finish()).toThrow("commandcode_truncated_output");
    const utf8 = new ResultStream(); utf8.push(Buffer.from([0xe4]));
    expect(() => utf8.finish()).toThrow("commandcode_truncated_utf8");
    expect(() => new ResultStream().finish()).toThrow("commandcode_missing_result");
  });
});
