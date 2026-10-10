import type { AdapterExecutionContext, AdapterExecutionResult, AdapterEnvironmentTestContext, AdapterEnvironmentTestResult, AdapterEnvironmentCheck, ServerAdapterModule } from "@paperclipai/adapter-utils";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { CLI_VERSION, resolveConfig, isolatedEnvironment, redact } from "./config.js";
import { mapUsage } from "./protocol.js";
import { runProcess } from "./process.js";

export const type = "commandcode_local";
export const label = "CommandCode (qualification)";
export const agentConfigurationDoc = `# CommandCode qualification adapter
Pinned CLI 1.79.2. Local, fresh-session, isolated-home qualification only.
Required: cliPackageDir, stateRoot, model, qualificationMode=true,
spendAuthorizationRef (operator's approved experiment reference), promptTemplate.
authMode=commandcode accepts COMMAND_CODE_API_KEY; authMode=byok accepts provider keys.
env keys must be supplied explicitly through Paperclip secret bindings. Auth modes cannot mix.
No inherited credentials, Paperclip JWT, project cwd, remote execution, automatic resume,
tools-all, trust bypass, or production/customer-code execution.
Plan permission mode and a fresh empty workspace are risk limits, NOT an OS sandbox.
maxTurns and timeoutSec are not dollar caps. Costs remain unpriced; do not use unattended.
Cache-write usage semantics and remote inference stop are unqualified. No safe-replay claim.
No automatic model discovery or model substitution. testEnvironment runs version only.
`;

function failure(code: string): AdapterExecutionResult {
  return { exitCode: 1, signal: null, timedOut: false, errorCode: code,
    errorMessage: code, errorFamily: "configuration", costStatus: "unpriced", usageComplete: false };
}

function binding(ctx: AdapterExecutionContext) {
  const issueId = ctx.context.issueId ?? ctx.context.taskId ?? ctx.runtime.taskKey;
  if (typeof issueId !== "string" || !issueId) throw new Error("commandcode_issue_binding_required");
  return { companyId: ctx.agent.companyId, agentId: ctx.agent.id, issueId, runId: ctx.runId };
}

async function directories(config: Awaited<ReturnType<typeof resolveConfig>>, scope: Record<string, unknown>) {
  const key = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
  const root = path.join(config.stateRoot, key);
  const home = path.join(root, "home"), cwd = path.join(root, "work");
  for (const directory of [home, cwd, ...["appdata", "localappdata", "config", "data", "cache", "tmp"].map((name) => path.join(home, name))]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  return { home, cwd };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  let config, scope;
  try {
    if ((ctx.executionTarget && ctx.executionTarget.kind !== "local") || ctx.executionTransport?.remoteExecution) throw new Error("commandcode_remote_unsupported");
    if (ctx.config.qualificationMode !== true) throw new Error("commandcode_qualification_only");
    if (typeof ctx.config.spendAuthorizationRef !== "string" || !ctx.config.spendAuthorizationRef.trim()) throw new Error("commandcode_spend_authorization_required");
    if (ctx.config.resume === true) throw new Error("commandcode_resume_unqualified");
    if (typeof ctx.config.promptTemplate !== "string" || !ctx.config.promptTemplate.trim() || Buffer.byteLength(ctx.config.promptTemplate) > 64000) throw new Error("commandcode_prompt_required_or_too_large");
    config = await resolveConfig(ctx.config);
    if (!Object.keys(config.credentials).length) throw new Error("commandcode_explicit_credentials_required");
    scope = binding(ctx);
  } catch (error) { return failure(error instanceof Error && error.message.startsWith("commandcode_") ? error.message : "commandcode_config_unavailable"); }
  await ctx.onCancellationReady?.();
  if (ctx.signal?.aborted) return { ...failure("commandcode_cancelled_before_spawn"), errorFamily: null, exitCode: 130 };
  const { cwd, home } = await directories(config, scope);
  const args = ["-p", "--output-format", "json", "--no-auto-update", "--skip-onboarding", "--no-skills",
    "--permission-mode", "plan", "--model", config.model, "--max-turns", String(config.maxTurns)];
  if (config.authMode === "byok") args.push("--local-only");
  if (config.effort) args.push("--effort", config.effort);
  await ctx.onMeta?.({ adapterType: type, command: process.execPath, cwd,
    commandArgs: [config.entry, ...args], commandNotes: ["Fresh qualification workspace; stdin prompt; cost unpriced; no resume."],
    context: { ...scope, cliVersion: CLI_VERSION, bundleSha256: config.digest } });
  const outcome = await runProcess({ entry: config.entry, args, cwd,
    env: isolatedEnvironment(home, config.credentials, config.authMode === "byok"), input: ctx.config.promptTemplate,
    timeoutMs: config.timeoutSec * 1000, signal: ctx.signal,
    onSpawn: ctx.onSpawn ?? (async () => { ctx.onDispatch?.(); }) });
  const result = outcome.result;
  const errorCode = outcome.cancelled ? "commandcode_cancelled_external_state_unknown"
    : outcome.timedOut ? "commandcode_timeout_external_state_unknown"
    : outcome.failure ?? (outcome.code !== 0 ? `commandcode_exit_${outcome.code ?? "signal"}`
      : result?.subtype !== "success" ? `commandcode_${result?.subtype ?? "missing_result"}` : null);
  const usage = result ? mapUsage(result.usage) : undefined;
  const reportedModel = outcome.reportedModels.length === 1 ? redact(outcome.reportedModels[0], config.credentials) : null;
  // Only final result is an accounting candidate; event observations are never added again.
  await ctx.onUsage?.({ attemptId: ctx.runId, usage, usageBasis: "per_run", billingType: "unknown",
    model: reportedModel,
    costStatus: "unpriced", complete: false, pricingProvenance: { source: "unknown" } });
  const summary = result ? redact(result.finalText, config.credentials) : errorCode;
  await ctx.onLog("stdout", JSON.stringify({ type: "onisall_commandcode_result", summary, errorCode,
    costStatus: "unpriced", usageComplete: false, events: outcome.events }) + "\n");
  return {
    exitCode: errorCode ? (outcome.code && outcome.code !== 0 ? outcome.code : 1) : 0,
    signal: outcome.signal, timedOut: outcome.timedOut, errorCode, errorMessage: errorCode,
    usage, usageBasis: "per_run", costStatus: "unpriced", billingType: "unknown", usageComplete: false,
    model: reportedModel,
    pricingProvenance: { source: "unknown" }, summary,
    sessionParams: result?.sessionId ? { version: 1, ...scope, sessionId: result.sessionId, resumeQualified: false } : null,
    sessionDisplayId: result?.sessionId ?? null,
    resultJson: { schema: "onisall.commandcode.execution.v1", ...scope, requestedModel: config.model,
      actualModel: null, authMode: config.authMode, cliVersion: CLI_VERSION, bundleSha256: config.digest,
      cliReportedModels: outcome.reportedModels.map((model) => redact(model, config.credentials)),
      rawFinalUsage: result?.usage ?? null, usageMapping: usage ? "sdk_total_minus_cache_read_v1" : "unqualified",
      events: outcome.events, stdoutBytes: outcome.outputBytes, stderrBytes: outcome.stderrBytes,
      localProcess: outcome.localProcess,
      externalActionState: "unknown", acceptance: "not_evaluated", resumeQualified: false },
  };
}

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  
  const checks: AdapterEnvironmentCheck[] = [];
  try {
    if (ctx.executionTarget && ctx.executionTarget.kind !== "local") throw new Error("commandcode_remote_unsupported");
    const config = await resolveConfig(ctx.config);
    const { cwd, home } = await directories(config, { probe: true, companyId: ctx.companyId });
    const result = await runProcess({ entry: config.entry, args: ["--version"], cwd,
      env: isolatedEnvironment(home, {}, true), input: "", timeoutMs: 15000, parse: false });
    if (result.code !== 0 || result.failure || result.timedOut || result.stdout.trim() !== CLI_VERSION) throw new Error("commandcode_version_probe_failed");
    checks.push({ level: "info", code: "commandcode_version", message: `Pinned CommandCode ${CLI_VERSION} detected; no model invoked.` });
    checks.push({ level: "warn", code: "commandcode_qualification_pending", message: "Version-only probe does not verify credentials or live capability. Cache writes, full isolation, remote stop and resume remain unqualified. Execution is limited to authorized local experiments." });
  } catch (error) {
    checks.push({ level: "error", code: "commandcode_environment", message: error instanceof Error && error.message.startsWith("commandcode_") ? error.message : "CommandCode installation unavailable." });
  }
  return { adapterType: type, status: checks.some((check) => check.level === "error") ? "fail" : "warn", checks, testedAt: new Date().toISOString() };
}

export function createServerAdapter(): ServerAdapterModule {
  return { type, execute, testEnvironment, agentConfigurationDoc, models: [],
    supportsLocalAgentJwt: false, supportsInstructionsBundle: false, supportsToolRefreshOnResume: false,
    sessionCodec: {
      // Evidence can be persisted, but no session can be automatically restored yet.
      serialize: (value) => value, deserialize: () => null,
      getDisplayId: (value) => typeof value?.sessionId === "string" ? value.sessionId : null,
    },
    getConfigSchema: () => ({ fields: [
      { key: "cliPackageDir", label: "CommandCode package directory", type: "text", required: true },
      { key: "stateRoot", label: "Isolated experiment directory", type: "text", required: true },
      { key: "model", label: "Exact model ID", type: "text", required: true },
      { key: "authMode", label: "Authentication source", type: "select", default: "commandcode",
        options: [{ value: "commandcode", label: "CommandCode account API key" }, { value: "byok", label: "Provider API key (local-only)" }] },
      { key: "effort", label: "Reasoning effort", type: "select", options: ["low", "medium", "high"].map((value) => ({ value, label: value })) },
      { key: "promptTemplate", label: "Experiment prompt", type: "textarea", required: true },
      { key: "maxTurns", label: "Maximum turns", type: "number", default: 2, hint: "1–10; not a spending cap." },
      { key: "timeoutSec", label: "Timeout in seconds", type: "number", default: 120 },
      { key: "qualificationMode", label: "Use for local qualification", type: "toggle", default: false },
      { key: "spendAuthorizationRef", label: "Approved experiment reference", type: "text", required: true,
        hint: "Record model, credential binding and budget in the referenced work document first." },
    ] }),
  };
}
