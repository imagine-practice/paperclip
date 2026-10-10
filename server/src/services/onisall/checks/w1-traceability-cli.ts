import { z } from "zod";
import { parseStrictJson, STRICT_JSON_LIMITS } from "../strict-json.js";
import { createTraceabilityChecker } from "./w1-traceability.js";
import { W1_TRACEABILITY_PROFILE } from "./w1-coverage.js";

const envelope = z.object({ protocol: z.literal("onisall.w1-traceability-input.v1"),
  candidate_base64: z.string().min(1).max(STRICT_JSON_LIMITS.bytes),
  source_base64: z.string().min(1).max(STRICT_JSON_LIMITS.bytes),
}).strict();
const checker = createTraceabilityChecker(W1_TRACEABILITY_PROFILE);
let finished = false, size = 0;
const chunks: Buffer[] = [];
function send(value: unknown, code: number) {
  if (finished) return;
  finished = true; clearTimeout(timer);
  process.stdout.write(JSON.stringify(value) + "\n", () => process.exit(code));
}
function refuse(reason: string) {
  send({ protocol: "onisall.w1-traceability-cli-error.v1", outcome: "fail", reason }, 2);
}
function decode(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("invalid_envelope");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("invalid_envelope");
  return bytes;
}
const timer = setTimeout(() => refuse("input_timeout"), 5000);
process.stdout.on("error", () => process.exit(2));
if (process.argv.length !== 2) refuse("unsupported_arguments");
process.stdin.on("data", (chunk: Buffer) => {
  if (finished) return;
  size += chunk.byteLength;
  if (size > STRICT_JSON_LIMITS.bytes) { refuse("input_too_large"); return; }
  chunks.push(chunk);
});
process.stdin.on("error", () => refuse("input_error"));
process.stdin.on("end", () => {
  if (finished) return;
  try {
    const parsed = envelope.safeParse(parseStrictJson(Buffer.concat(chunks)));
    if (!parsed.success) { refuse("invalid_envelope"); return; }
    const result = checker.check(decode(parsed.data.candidate_base64), decode(parsed.data.source_base64));
    send(result, result.outcome === "pass" ? 0 : 1);
  } catch { refuse("invalid_envelope"); }
});
