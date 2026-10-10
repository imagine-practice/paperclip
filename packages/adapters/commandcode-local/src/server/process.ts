import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
export interface ProcessOptions {
  entry: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  input?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onSpawn?: AdapterExecutionContext["onSpawn"];
  parse?: boolean;
}
interface StopAttempt { requestedAt: string | null; method: string | null; exitCode: number | null }
interface ProcessExit { code: number | null; signal: string | null }

import { spawn } from "node:child_process";
import path from "node:path";
import { ResultStream, MAX_OUTPUT } from "./protocol.js";

export async function runProcess({ entry, args, cwd, env, input, timeoutMs, signal, onSpawn, parse = true }: ProcessOptions) {
  const parser = new ResultStream();
  let stderrBytes = 0, stdout = "", timedOut = false, cancelled = false;
  
  let failure: string | null = null;
  let closed = false, exited = false;
  
  const stopAttempt: StopAttempt = { requestedAt: null, method: null, exitCode: null };
  
  let stopPromise: Promise<void> | undefined;
  const child = spawn(process.execPath, [entry, ...args], {
    cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  
  const completed = new Promise<ProcessExit>((resolve) => {
    child.once("error", () => { failure ??= "commandcode_spawn_failed"; });
    child.once("exit", () => { exited = true; });
    child.once("close", (code, exitSignal) => { closed = true; resolve({ code, signal: exitSignal }); });
  });

  async function stop() {
    if (closed || !child.pid) return;
    if (exited) {
      // A descendant may still hold a pipe open. The former parent's PID is no
      // longer authority to kill anything: Windows can reuse it immediately.
      failure ??= "commandcode_descendant_state_unknown";
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      return;
    }
    const pid = child.pid;
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopAttempt.requestedAt = new Date().toISOString();
      if (process.platform === "win32") {
        const systemRoot = process.env.SystemRoot;
        if (!systemRoot || !path.isAbsolute(systemRoot)) {
          failure = "commandcode_tree_stop_unavailable";
          stopAttempt.method = "child_kill_fallback";
          child.kill();
          return;
        }
        await new Promise<void>((resolve) => {
          stopAttempt.method = "taskkill_tree";
          const killer = spawn(path.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"],
            { shell: false, windowsHide: true, stdio: "ignore" });
          const deadline = setTimeout(() => { killer.kill(); if (!exited) child.kill(); }, 10000);
          killer.once("error", () => { failure = "commandcode_tree_stop_failed"; if (!exited) child.kill(); });
          killer.once("close", (code) => {
            stopAttempt.exitCode = code;
            clearTimeout(deadline);
            if (code !== 0 && !closed) { failure = "commandcode_tree_stop_failed"; if (!exited) child.kill(); }
            resolve(undefined);
          });
        });
      } else {
        stopAttempt.method = "process_group_sigkill";
        try { process.kill(-pid, "SIGKILL"); }
        catch { if (!closed) { failure = "commandcode_tree_stop_failed"; child.kill("SIGKILL"); } }
      }
    })();
    return stopPromise;
  }

  const abort = () => { cancelled = true; void stop(); };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; void stop(); }, timeoutMs);
  child.stdin.on("error", () => { if (!closed) { failure ??= "commandcode_stdin_failed"; void stop(); } });
  child.stdout.on("data", (chunk) => {
    if (failure) return;
    try {
      if (parse) parser.push(chunk);
      else {
        stdout += chunk.toString("utf8");
        if (Buffer.byteLength(stdout) > 4096) throw new Error("commandcode_probe_output_limit");
      }
    } catch (error) { failure = error instanceof Error ? error.message : "commandcode_protocol_error"; void stop(); }
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_OUTPUT) { failure ??= "commandcode_stderr_limit"; void stop(); }
  });
  try {
    // Register after OS spawn, before supplying any model prompt.
    if (child.pid) {
      try { await onSpawn?.({ pid: child.pid, processGroupId: process.platform === "win32" ? null : child.pid, startedAt: new Date().toISOString() }); }
      catch { failure = "commandcode_spawn_receipt_failed"; await stop(); }
    }
    if (signal?.aborted) abort();
    if (!failure && !cancelled && !closed) child.stdin.end(input ?? "");
    const outcome = await completed;
    await stopPromise;
    let result = null;
    if (parse && !failure && !cancelled && !timedOut) {
      try { result = parser.finish(); } catch (error) { failure = error instanceof Error ? error.message : "commandcode_protocol_error"; }
    }
    return { ...outcome, result, failure, timedOut, cancelled, stderrBytes, stdout,
      outputBytes: parser.bytes, events: Object.fromEntries(parser.eventCounts), reportedModels: [...parser.reportedModels],
      localProcess: { pid: child.pid ?? null, exitObserved: exited, closeObserved: closed,
        stopAttempt, descendantState: "unknown", remoteState: "unknown" } };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (!closed) await stop();
  }
}
