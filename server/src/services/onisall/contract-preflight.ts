import { z } from "zod";
import { sha256 } from "./input-snapshot.js";
import { parseStrictJson, StrictJsonError, STRICT_JSON_LIMITS } from "./strict-json.js";
import { createOfflineSchemaRegistry, type PinnedSchemaRef } from "./schema-registry.js";
import { freezeSchemaValidators } from "./schema-compiler.js";
import { createOfflineCheckRegistry, checkIdentity, compareUtf8, freezePreparation,
  parsePreparation, preparationHash, preparationJson } from "./check-registry.js";
import { createOfflineCommandRegistry, verificationCommand } from "./command-registry.js";
import { prepareRequiredCheckMatrix, type MatrixPreparationInput } from "./required-check-matrix.js";

export class ContractPreflightError extends Error {
  constructor(readonly code: "invalid_contract" | "invalid_schema_profile" | "duplicate_command" |
    "incomplete_coverage" | "unexpected_check" | "ambiguous_command" | "timeout_exceeds_limit" | "check_metadata_mismatch") {
    super(code); this.name = "ContractPreflightError";
  }
}

// This is the typed slice read after validation against the complete trusted v3
// document. It is not a second, less strict TaskContract Schema.
interface ContractFields {
  kind: "task_contract"; schema_version: 3; contract_id: string; revision: number;
  artifact_requirements: MatrixPreparationInput["artifact_requirements"];
  verification_commands: z.infer<typeof verificationCommand>[];
  limits: { max_execution_seconds: number };
}

export function acceptanceCriteriaProjection(contract: Pick<ContractFields,
  "contract_id" | "revision" | "artifact_requirements" | "verification_commands">) {
  const requirements = structuredClone(contract.artifact_requirements);
  const commands = structuredClone(contract.verification_commands);
  if (new Set(requirements.map(r => r.artifact_kind)).size !== requirements.length ||
      new Set(commands.map(c => c.command_id)).size !== commands.length) throw new ContractPreflightError("invalid_contract");
  for (const requirement of requirements) {
    if (new Set(requirement.required_checks.map(c => c.check_id)).size !== requirement.required_checks.length) {
      throw new ContractPreflightError("invalid_contract");
    }
    requirement.required_checks.sort((a, b) => compareUtf8(a.check_id, b.check_id));
  }
  requirements.sort((a, b) => compareUtf8(a.artifact_kind, b.artifact_kind));
  commands.sort((a, b) => compareUtf8(a.command_id, b.command_id));
  return freezePreparation({ hash_protocol: "onisall.acceptance-criteria.v1", contract_id: contract.contract_id,
    contract_revision: contract.revision, artifact_requirements: requirements, verification_commands: commands });
}

// Bootstrap the contract validator from trusted deployment assets. Artifact
// selections compile synchronously during offline preparation, exclusively
// from registered bytes. This factory exposes no HTTP or registration path.
export function createContractPreflight(input: {
  contractSchemaRef: PinnedSchemaRef;
  schemas: ReturnType<typeof createOfflineSchemaRegistry>;
  checks: ReturnType<typeof createOfflineCheckRegistry>;
  commands: ReturnType<typeof createOfflineCommandRegistry>;
}) {
  const root = input.schemas.resolve(input.contractSchemaRef);
  const document = root.schema as Record<string, unknown> | null;
  if (!document || typeof document !== "object" || document.$id !== "urn:onisall:paperclip:capability-contracts:3") {
    throw new ContractPreflightError("invalid_schema_profile");
  }
  const contractSchemas = freezeSchemaValidators(input.schemas, [root.ref]);
  // Capture references rather than retaining a mutable caller options object.
  const schemaRegistry = input.schemas, checks = input.checks, commands = input.commands;
  return Object.freeze({
    inspect(bytes: Uint8Array, outputBounds: MatrixPreparationInput["output_bounds"]) {
      if (!(bytes instanceof Uint8Array)) throw new StrictJsonError("invalid_json");
      if (bytes.byteLength > STRICT_JSON_LIMITS.bytes) throw new StrictJsonError("input_too_large");
      const owned = Buffer.from(bytes);
      const raw = parseStrictJson(owned);
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.kind !== "task_contract" ||
          raw.schema_version !== 3 || !contractSchemas.validate(root.ref, owned).valid) {
        throw new ContractPreflightError("invalid_contract");
      }
      const contract = raw as unknown as ContractFields;
      const selections = parsePreparation(z.array(verificationCommand).min(1).max(500), contract.verification_commands);
      if (new Set(selections.map(c => c.command_id)).size !== selections.length) throw new ContractPreflightError("duplicate_command");
      const refs = new Map(contract.artifact_requirements.map(r => [preparationJson(r.schema_ref), r.schema_ref]));
      const artifactSchemas = freezeSchemaValidators(schemaRegistry, [...refs.values()]);
      const matrix = prepareRequiredCheckMatrix({ artifact_requirements: contract.artifact_requirements,
        output_bounds: outputBounds }, checks, artifactSchemas);
      const required = new Map(matrix.manifest.checks.map(spec => [checkIdentity(spec.check), spec]));
      const covered = new Set<string>();
      const resolved = selections.sort((a, b) => compareUtf8(a.command_id, b.command_id)).map(selection => {
        const asset = commands.resolve(selection);
        const key = checkIdentity(selection.validator), spec = required.get(key);
        if (!spec || preparationJson(spec.check) !== preparationJson(selection.validator)) throw new ContractPreflightError("unexpected_check");
        if (preparationJson(spec) !== preparationJson(asset.check_descriptor)) throw new ContractPreflightError("check_metadata_mismatch");
        if (covered.has(key)) throw new ContractPreflightError("ambiguous_command");
        covered.add(key);
        if (asset.descriptor.timeout_ms > contract.limits.max_execution_seconds * 1000) throw new ContractPreflightError("timeout_exceeds_limit");
        return { command_id: selection.command_id, ...asset };
      });
      if (covered.size !== required.size) throw new ContractPreflightError("incomplete_coverage");
      const acceptanceCriteriaHash = preparationHash(acceptanceCriteriaProjection(contract));
      const snapshot = freezePreparation({
        protocol: "onisall.contract-preflight.v1", status: "offline_prepared", execution_admission: "not_granted",
        contract_id: contract.contract_id, contract_revision: contract.revision,
        candidate_bytes_sha256: sha256(owned), acceptance_criteria_hash: acceptanceCriteriaHash,
        contract_schema_set_sha256: contractSchemas.manifestSha256,
        artifact_schema_set_sha256: artifactSchemas.manifestSha256,
        required_check_plan_sha256: matrix.planSha256,
        output_bounds: matrix.manifest.output_bounds, commands: resolved,
      });
      return Object.freeze({ snapshot, snapshotSha256: preparationHash(snapshot),
        matrix, artifactSchemas });
    },
  });
}
