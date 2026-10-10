import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProcess } from "./process.js";

const created: string[] = [];
async function child(source: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "onisall-commandcode-test-"));
  created.push(root);
  const entry = path.join(root, "fixture.cjs");
  await writeFile(entry, source);
  return { entry, cwd: root, args: [], env: {}, timeoutMs: 3000 };
}
afterEach(async () => {
  for (const directory of created.splice(0)) {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("onisall-commandcode-test-")) {
      throw new Error("Unexpected fixture cleanup path");
    }
    await rm(directory, { recursive: true, force: true });
  }
});
describe("CommandCode owned synthetic process", () => {
  it("sends input through stdin after spawn acknowledgement and reads a terminal result", async () => {
    const options = await child(`let input=""; process.stdin.on("data",c=>input+=c); process.stdin.on("end",()=>console.log(JSON.stringify({type:"result",subtype:"success",finalText:input,durationMs:1,usage:{inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0}})));`);
    let spawned = false;
    const outcome = await runProcess({ ...options, input: "literal $() prompt", onSpawn: async meta => { expect(meta.pid).toBeGreaterThan(0); spawned = true; } });
    expect(spawned).toBe(true);
    expect(outcome.result?.finalText).toBe("literal $() prompt");
    expect(outcome.failure).toBeNull();
    expect(outcome.localProcess).toMatchObject({ exitObserved: true, closeObserved: true, remoteState: "unknown", descendantState: "unknown" });
  });
  it("stops a timed-out fixture without claiming provider confirmation", async () => {
    const options = await child("setInterval(()=>{},1000)");
    const outcome = await runProcess({ ...options, timeoutMs: 150 });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.localProcess.closeObserved).toBe(true);
    expect(outcome.localProcess.remoteState).toBe("unknown");
    expect(outcome.result).toBeNull();
  });
  it("honors cancellation and refuses a missing terminal record", async () => {
    const options = await child("setInterval(()=>{},1000)");
    const abort = new AbortController();
    const outcome = await runProcess({ ...options, signal: abort.signal, onSpawn: async () => { abort.abort(); } });
    expect(outcome.cancelled).toBe(true);
    expect(outcome.localProcess.closeObserved).toBe(true);
    const empty = await runProcess(await child("process.exit(0)"));
    expect(empty.failure).toBe("commandcode_missing_result");
  });
});
