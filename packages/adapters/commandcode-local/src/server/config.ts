import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const CLI_VERSION = "1.79.2";
export const BUNDLE_SHA256 = "d976c2ad89f93a2b81af4d150dca99aeedfd679f15e8b8c032314e61e484da7b";
const USAGE_DEPENDENCIES = [
  ["ai", "6.0.302", "e50f03b8ff579ce2b33f600f9f9786a6561d7ecc8b06d5d1941b798128de9982"],
  ["@ai-sdk/openai-compatible", "2.0.81", "ceca4fa14070267bd7794705ac5cef6dfc4910ba2bde49920a38502f1814f36e"],
];
const CREDENTIALS = new Set(["COMMAND_CODE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY"]);

function integer(value: unknown, fallback: number, min: number, max: number) {
  const result = value ?? fallback;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < min || result > max) throw new Error("commandcode_invalid_limit");
  return result;
}

export async function resolveConfig(config: Record<string, unknown>) {
  if (typeof config.cliPackageDir !== "string" || !path.isAbsolute(config.cliPackageDir)) throw new Error("commandcode_package_path_required");
  const root = await realpath(config.cliPackageDir);
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (pkg.name !== "command-code" || pkg.version !== CLI_VERSION) throw new Error("commandcode_cli_version_mismatch");
  const entry = await realpath(path.join(root, "dist", "cli.mjs"));
  if (path.dirname(entry) !== path.join(root, "dist")) throw new Error("commandcode_entry_outside_package");
  if ((await stat(entry)).size > 16 * 1024 * 1024) throw new Error("commandcode_bundle_size");
  const digest = createHash("sha256").update(await readFile(entry)).digest("hex");
  if (digest !== BUNDLE_SHA256) throw new Error("commandcode_cli_digest_mismatch");
  for (const [name, version, expected] of USAGE_DEPENDENCIES) {
    const dependency = path.join(root, "node_modules", name);
    const metadata = JSON.parse(await readFile(path.join(dependency, "package.json"), "utf8"));
    const hash = createHash("sha256").update(await readFile(path.join(dependency, "dist/index.mjs"))).digest("hex");
    if (metadata.version !== version || hash !== expected) throw new Error("commandcode_usage_dependency_mismatch");
  }
  if (typeof config.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(config.model)) throw new Error("commandcode_explicit_model_required");
  if (config.effort !== undefined && (typeof config.effort !== "string" || !["low", "medium", "high"].includes(config.effort))) throw new Error("commandcode_invalid_effort");
  if (typeof config.stateRoot !== "string" || !path.isAbsolute(config.stateRoot)) throw new Error("commandcode_state_root_required");
  const authMode = config.authMode ?? "commandcode";
  if (authMode !== "commandcode" && authMode !== "byok") throw new Error("commandcode_invalid_auth_mode");
  
  const credentials: Record<string, string> = {};
  if (config.env !== undefined) {
    if (!config.env || typeof config.env !== "object" || Array.isArray(config.env)) throw new Error("commandcode_invalid_env");
    for (const [key, value] of Object.entries(config.env)) {
      // The host merges platform variables into the resolved environment. Drop
      // every non-credential key; never forward a run JWT or host configuration.
      if (!CREDENTIALS.has(key)) continue;
      if (typeof value !== "string" || !value || value.includes("\0")) throw new Error("commandcode_env_not_allowed");
      credentials[key] = value;
    }
  }
  if (Object.keys(credentials).some((key) => authMode === "commandcode" ? key !== "COMMAND_CODE_API_KEY" : key === "COMMAND_CODE_API_KEY")) throw new Error("commandcode_mixed_auth_modes");
  return { root, entry, digest, model: config.model, effort: config.effort,
    stateRoot: path.resolve(config.stateRoot), credentials, authMode,
    maxTurns: integer(config.maxTurns, 2, 1, 10), timeoutSec: integer(config.timeoutSec, 120, 10, 600) };
}

export function isolatedEnvironment(home: string, credentials: Record<string, string>, localOnly: boolean) {
  
  const env: Record<string, string> = {};
  for (const key of ["SystemRoot", "WINDIR", "LANG", "LC_ALL"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  // No inherited HOME, PATH, NODE_OPTIONS, proxy, Paperclip token, cloud credentials or CLI config.
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, "appdata"),
    LOCALAPPDATA: path.join(home, "localappdata"), XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"), XDG_CACHE_HOME: path.join(home, "cache"),
    TEMP: path.join(home, "tmp"), TMP: path.join(home, "tmp"),
    PATH: path.dirname(process.execPath), NODE_ENV: "production", NO_COLOR: "1", CI: "1", CMD_LOCAL_ONLY: localOnly ? "1" : "0" }, credentials);
  return env;
}

export function redact(text: string, credentials: Record<string, string>) {
  let safe = text;
  for (const value of Object.values(credentials)) safe = safe.split(value).join("[REDACTED]");
  return safe.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(?:sk-|sk_)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[REDACTED]@");
}
