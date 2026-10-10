import { afterEach, describe, expect, it, vi } from "vitest";
import { isolatedEnvironment, redact, resolveConfig } from "./config.js";
import { createServerAdapter, execute } from "./index.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

afterEach(() => vi.unstubAllEnvs());
describe("CommandCode adapter gates", () => {
  it("constructs an allowlisted environment without host secrets or runtime JWT", () => {
    vi.stubEnv("PAPERCLIP_API_KEY", "host-run-token");
    vi.stubEnv("OPENAI_API_KEY", "unrelated-key");
    vi.stubEnv("NODE_OPTIONS", "--inspect");
    vi.stubEnv("HTTPS_PROXY", "http://private-proxy");
    const env = isolatedEnvironment("qualification-home", { COMMAND_CODE_API_KEY: "bound-key" }, false);
    expect(env.COMMAND_CODE_API_KEY).toBe("bound-key");
    expect(env.HOME).toBe("qualification-home");
    expect(env.CMD_LOCAL_ONLY).toBe("0");
    for (const key of ["PAPERCLIP_API_KEY", "OPENAI_API_KEY", "NODE_OPTIONS", "HTTPS_PROXY"]) expect(env).not.toHaveProperty(key);
    expect(isolatedEnvironment("home", {}, true).CMD_LOCAL_ONLY).toBe("1");
  });
  it("redacts credentials and common auth forms", () => {
    const text = redact("bound-key Bearer token sk-abcdefghijklmnop https://user:pass@example.org", { KEY: "bound-key" });
    expect(text).not.toMatch(/bound-key|Bearer token|sk-abcdefghijklmnop|user:pass/);
  });
  it("rejects a relative CLI path before touching the filesystem", async () => {
    await expect(resolveConfig({ cliPackageDir: "relative" })).rejects.toThrow("commandcode_package_path_required");
  });
  it.each([
    [{}, "commandcode_qualification_only"],
    [{ qualificationMode: true }, "commandcode_spend_authorization_required"],
    [{ qualificationMode: true, spendAuthorizationRef: "task", resume: true }, "commandcode_resume_unqualified"],
    [{ qualificationMode: true, spendAuthorizationRef: "task" }, "commandcode_prompt_required_or_too_large"],
  ])("preserves pre-execution refusal %#", async (config, code) => {
    const context: AdapterExecutionContext = { runId: "run", config, context: {},
      agent: { id: "agent", companyId: "company", name: "fixture", adapterType: "commandcode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "issue" },
      onLog: vi.fn(async () => {}), onSpawn: vi.fn(async () => {}), onProviderStopped: vi.fn(async () => {}) };
    const result = await execute(context);
    expect(result).toMatchObject({ errorCode: code, costStatus: "unpriced", usageComplete: false });
    expect(context.onSpawn).not.toHaveBeenCalled();
    expect(context.onProviderStopped).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("executionRecovery");
  });
  it("preserves external adapter and session contracts", () => {
    const adapter = createServerAdapter();
    expect(adapter.type).toBe("commandcode_local");
    expect(adapter.supportsLocalAgentJwt).toBe(false);
    expect(adapter.sessionCodec?.deserialize({ sessionId: "session123" })).toBeNull();
    expect(adapter.sessionCodec?.getDisplayId?.({ sessionId: "session123" })).toBe("session123");
    expect(adapter.getConfigSchema?.()).toHaveProperty("fields");
  });
});
