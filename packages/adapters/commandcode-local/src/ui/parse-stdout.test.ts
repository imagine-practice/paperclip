import { describe, expect, it } from "vitest";
import { parseStdoutLine } from "./parse-stdout.js";
describe("CommandCode UI parser", () => {
  it("parses normalized results without interpreting approval claims", () => {
    const entries = parseStdoutLine(JSON.stringify({ type: "onisall_commandcode_result", summary: "output", errorCode: null }), "now");
    expect(entries).toEqual([
      { kind: "assistant", ts: "now", text: "output", channel: "final" },
      { kind: "system", ts: "now", text: "CommandCode exited successfully. Acceptance and price are not yet established." },
    ]);
  });
  it.each(["{", "x".repeat(100001), JSON.stringify({ type: "result", finalText: "raw" })])("ignores unsupported input %#", line => {
    expect(parseStdoutLine(line, "now")).toEqual([]);
  });
});
