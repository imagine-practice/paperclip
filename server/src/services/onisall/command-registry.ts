import { z } from "zod";
import { sha256 } from "./input-snapshot.js";
import { parseStrictJson } from "./strict-json.js";
import { boundedText, checkReference, createOfflineCheckRegistry, digest, fixedRevision,
  freezePreparation, parsePreparation, preparationJson } from "./check-registry.js";

export const pinnedAssetRef = z.object({ registry_key: boundedText(200), revision: fixedRevision, sha256: digest }).strict();
export const verificationCommand = z.object({ command_id: boundedText(120), ref: pinnedAssetRef, validator: checkReference }).strict();
export type AssetRef = z.infer<typeof pinnedAssetRef>;
export type VerificationCommand = z.infer<typeof verificationCommand>;
export interface PinnedAsset { ref: AssetRef; bytes: Uint8Array }
const policySchema = z.object({
  protocol: z.literal("onisall.check-sandbox.v1"), network: z.literal("deny"),
  workspace: z.literal("read_only"), environment: z.literal("empty"), child_processes: z.literal("deny"),
}).strict();
const argument = z.string().max(4096).refine(value => !/[\u0000\r\n]/.test(value));
const commandSchema = z.object({
  protocol: z.literal("onisall.verification-command.v1"), validator: checkReference,
  runtime_ref: pinnedAssetRef,
  // Literal arguments, no shell. $VALIDATOR is the sole byte-asset placeholder;
  // a future qualified runner must materialize the exact verified bytes.
  argv: z.array(argument).min(1).max(64).refine(args => args.filter(arg => arg === "$VALIDATOR").length === 1),
  cwd: z.literal("isolated_artifact_workspace"), shell: z.literal(false),
  timeout_ms: z.number().int().min(1).max(86_400_000), sandbox_policy_ref: pinnedAssetRef,
}).strict();
export type CommandAssetDescriptor = z.infer<typeof commandSchema>;
export type CheckSandboxPolicy = z.infer<typeof policySchema>;

export class CommandRegistryError extends Error {
  constructor(readonly code: "invalid_asset" | "digest_mismatch" | "revision_conflict" |
    "not_registered" | "validator_mismatch") {
    super(code); this.name = "CommandRegistryError";
  }
}

function assetIdentity(ref: AssetRef) { return JSON.stringify([ref.registry_key, ref.revision]); }
function assetCatalog(entries: readonly PinnedAsset[], maximumBytes: number) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 500) throw new CommandRegistryError("invalid_asset");
  const map = new Map<string, { ref: AssetRef; bytes: Buffer }>();
  for (const entry of entries) {
    const ref = parsePreparation(pinnedAssetRef, entry.ref);
    if (!(entry.bytes instanceof Uint8Array) || !entry.bytes.byteLength || entry.bytes.byteLength > maximumBytes) {
      throw new CommandRegistryError("invalid_asset");
    }
    const bytes = Buffer.from(entry.bytes);
    if (sha256(bytes) !== ref.sha256) throw new CommandRegistryError("digest_mismatch");
    const key = assetIdentity(ref), previous = map.get(key);
    if (previous && !previous.bytes.equals(bytes)) throw new CommandRegistryError("revision_conflict");
    map.set(key, { ref, bytes });
  }
  return { entries: [...map.values()], resolve(raw: AssetRef) {
    const ref = parsePreparation(pinnedAssetRef, raw), found = map.get(assetIdentity(ref));
    if (!found) throw new CommandRegistryError("not_registered");
    if (found.ref.sha256 !== ref.sha256) throw new CommandRegistryError("digest_mismatch");
    return found;
  } };
}

// Construct from trusted local deployment bytes, never from a worker. No path,
// URL, module loader, process launcher, credentials or policy enforcement here.
export function createOfflineCommandRegistry(input: {
  commands: readonly PinnedAsset[]; runtimes: readonly PinnedAsset[]; policies: readonly PinnedAsset[];
  checks: ReturnType<typeof createOfflineCheckRegistry>;
}) {
  const commands = assetCatalog(input.commands, 64 * 1024);
  const runtimes = assetCatalog(input.runtimes, 256 * 1024 * 1024);
  const policies = assetCatalog(input.policies, 64 * 1024);
  const resolved = new Map<string, ReturnType<typeof resolveDescriptor>>();
  function resolveDescriptor(asset: { ref: AssetRef; bytes: Buffer }) {
    const descriptor = parsePreparation(commandSchema, parseStrictJson(asset.bytes));
    const check = input.checks.resolve(descriptor.validator);
    const runtime = runtimes.resolve(descriptor.runtime_ref);
    const sandbox = policies.resolve(descriptor.sandbox_policy_ref);
    const policy = parsePreparation(policySchema, parseStrictJson(sandbox.bytes));
    return freezePreparation({ ref: asset.ref, descriptor, runtime_ref: runtime.ref,
      sandbox_policy: policy, check_descriptor: check, evidence_mode: check.evidence_mode });
  }
  for (const asset of commands.entries) resolved.set(assetIdentity(asset.ref), resolveDescriptor(asset));
  return Object.freeze({
    resolve(raw: VerificationCommand) {
      const command = parsePreparation(verificationCommand, raw);
      const asset = commands.resolve(command.ref);
      const result = resolved.get(assetIdentity(asset.ref))!;
      if (preparationJson(result.descriptor.validator) !== preparationJson(command.validator)) {
        throw new CommandRegistryError("validator_mismatch");
      }
      return result;
    },
  });
}
