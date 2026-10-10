import type { TranscriptEntry, StdoutLineParser } from "@paperclipai/adapter-utils";

export const parseStdoutLine: StdoutLineParser = (line, ts) => {
  if (line.length > 100000) return [];
  let value;
  try { value = JSON.parse(line); } catch { return []; }
  if (value?.type !== "onisall_commandcode_result") return [];
  
  const entries: TranscriptEntry[] = [];
  if (typeof value.summary === "string") entries.push({ kind: "assistant", ts, text: value.summary, channel: "final" });
  entries.push({ kind: "system", ts, text: value.errorCode ? `CommandCode: ${value.errorCode}` : "CommandCode exited successfully. Acceptance and price are not yet established." });
  return entries;
}
