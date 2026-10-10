import { z } from "zod";
import type { freezeSchemaValidators } from "./schema-compiler.js";
import {
  boundedText, checkIdentity, checkReference, CheckPreparationError, compareUtf8,
  createOfflineCheckRegistry, digest, fixedRevision, freezePreparation,
  parsePreparation, preparationHash, preparationJson, type CheckDescriptor,
  type DeepReadonly, type RequiredCheck,
} from "./check-registry.js";

export const MAX_REQUIRED_CHECKS = 500;
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).refine(value => !Object.is(value, -0));
const revision = count.refine(value => value >= 1);
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const artifactKind = z.enum(["evidence_set", "change_set", "report_json", "report_html", "report_pdf", "code_result"]);
const schemaRef = z.object({ registry_key: boundedText(200), revision: fixedRevision, sha256: digest }).strict();
const requirement = z.object({
  artifact_kind: artifactKind, minimum_count: revision, schema_ref: schemaRef,
  required_checks: z.array(checkReference).min(1).max(100),
}).strict();
const outputBound = z.object({
  artifact_kind: artifactKind, max_count: count.max(1000),
  max_sources_per_artifact: count.max(10_000), max_claims_per_artifact: count.max(10_000),
}).strict();
const preparation = z.object({
  artifact_requirements: z.array(requirement).min(1).max(6),
  output_bounds: z.array(outputBound).min(1).max(6),
}).strict();
const artifact = z.object({
  artifact_id: uuid, revision, artifact_kind: artifactKind,
  source_ids: z.array(uuid).max(10_000), claim_ids: z.array(boundedText(200)).max(10_000),
}).strict();
const inventory = z.object({ artifact_set_hash: digest, artifacts: z.array(artifact).min(1).max(1000) }).strict();
const target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("artifact"), artifact_id: uuid, revision }).strict(),
  z.object({ kind: z.literal("artifact_set"), artifact_set_hash: digest }).strict(),
  z.object({ kind: z.literal("source"), evidence_id: uuid }).strict(),
  z.object({ kind: z.literal("claim"), artifact_id: uuid, revision, claim_id: boundedText(200) }).strict(),
]);
const matrixEntry = checkReference.extend({ target, blocking: z.literal(true) }).strict();
export type CheckTarget = z.infer<typeof target>;
export type RequiredMatrixEntry = z.infer<typeof matrixEntry>;
export type MatrixPreparationInput = z.infer<typeof preparation>;
export type ArtifactTargetInventory = z.infer<typeof inventory>;

function unique<T>(items: readonly T[], key: (item: T) => string) {
  if (new Set(items.map(key)).size !== items.length) throw new CheckPreparationError("duplicate_input");
}

function matrixKey(entry: Pick<RequiredMatrixEntry, "target" | "check_id" | "revision">): string {
  return preparationJson({ target: entry.target, check_id: entry.check_id, revision: entry.revision });
}

// This is a component of publication preflight, never a published contract or
// authorization. The frozen schema set must come from trusted deployment code.
export function prepareRequiredCheckMatrix(
  input: MatrixPreparationInput,
  registry: ReturnType<typeof createOfflineCheckRegistry>,
  schemas: ReturnType<typeof freezeSchemaValidators>,
) {
  const parsed = parsePreparation(preparation, input);
  const requirements = parsed.artifact_requirements.sort((a, b) => compareUtf8(a.artifact_kind, b.artifact_kind));
  const bounds = parsed.output_bounds.sort((a, b) => compareUtf8(a.artifact_kind, b.artifact_kind));
  unique(requirements, item => item.artifact_kind);
  unique(bounds, item => item.artifact_kind);
  if (preparationJson(requirements.map(r => r.artifact_kind)) !== preparationJson(bounds.map(b => b.artifact_kind))) {
    throw new CheckPreparationError("invalid_bounds");
  }
  const specs = new Map<string, DeepReadonly<CheckDescriptor>>();
  const versions = new Map<string, string>();
  const setChecks = new Set<string>();
  let capacity = 0;
  let artifactCapacity = 0;
  for (const [index, requirement] of requirements.entries()) {
    const bound = bounds[index]!;
    if (bound.max_count < requirement.minimum_count) throw new CheckPreparationError("invalid_bounds");
    artifactCapacity += bound.max_count;
    if (artifactCapacity > 1000) throw new CheckPreparationError("invalid_bounds");
    if (!schemas.manifest.schemas.some(ref => preparationJson(ref) === preparationJson(requirement.schema_ref))) {
      throw new CheckPreparationError("schema_not_frozen");
    }
    unique(requirement.required_checks, check => check.check_id);
    requirement.required_checks.sort((a, b) => compareUtf8(a.check_id, b.check_id));
    for (const check of requirement.required_checks) {
      // A single plan cannot use different revisions of one logical check.
      const identity = checkIdentity(check);
      if (versions.has(check.check_id) && versions.get(check.check_id) !== identity) throw new CheckPreparationError("revision_conflict");
      versions.set(check.check_id, identity);
      const spec = registry.resolve(check);
      specs.set(identity, spec);
      for (const kind of spec.target_kinds) {
        if (kind === "artifact_set") { setChecks.add(identity); continue; }
        const multiplier = kind === "artifact" ? 1 : kind === "source"
          ? bound.max_sources_per_artifact : bound.max_claims_per_artifact;
        if (multiplier === 0) throw new CheckPreparationError("invalid_bounds");
        capacity += bound.max_count * multiplier;
        if (capacity > MAX_REQUIRED_CHECKS) throw new CheckPreparationError("capacity_exceeded");
      }
    }
  }
  capacity += setChecks.size;
  if (capacity === 0 || capacity > MAX_REQUIRED_CHECKS) throw new CheckPreparationError("capacity_exceeded");
  const manifest = freezePreparation({
    protocol: "onisall.required-check-plan.v1" as const,
    schema_set_sha256: schemas.manifestSha256,
    artifact_requirements: requirements,
    output_bounds: bounds,
    checks: [...specs.values()].sort((a, b) => compareUtf8(checkIdentity(a.check), checkIdentity(b.check))),
    maximum_checks: capacity,
  });
  const planSha256 = preparationHash(manifest);

  function expand(raw: ArtifactTargetInventory) {
    // Caller must independently resolve sealed bytes, scope, content hashes,
    // citation sources and ALL claims (including uncited ones). This inventory
    // carries no such attestation and cannot itself make a GateVerdict pass.
    const input = parsePreparation(inventory, raw);
    unique(input.artifacts, a => JSON.stringify([a.artifact_id, a.revision]));
    const counts = new Map<string, number>();
    const entries = new Map<string, RequiredMatrixEntry>();
    function add(check: RequiredCheck, target: CheckTarget) {
      const entry = { ...check, target, blocking: true as const };
      entries.set(matrixKey(entry), entry);
      if (entries.size > MAX_REQUIRED_CHECKS) throw new CheckPreparationError("capacity_exceeded");
    }
    for (const artifact of input.artifacts) {
      const index = requirements.findIndex(r => r.artifact_kind === artifact.artifact_kind);
      if (index < 0) throw new CheckPreparationError("unexpected_artifact");
      const bound = bounds[index]!;
      unique(artifact.source_ids, id => id);
      unique(artifact.claim_ids, id => id);
      const amount = (counts.get(artifact.artifact_kind) ?? 0) + 1;
      counts.set(artifact.artifact_kind, amount);
      if (amount > bound.max_count || artifact.source_ids.length > bound.max_sources_per_artifact ||
          artifact.claim_ids.length > bound.max_claims_per_artifact) throw new CheckPreparationError("invalid_bounds");
      for (const check of requirements[index]!.required_checks) {
        for (const kind of specs.get(checkIdentity(check))!.target_kinds) {
          if (kind === "artifact") add(check, { kind, artifact_id: artifact.artifact_id, revision: artifact.revision });
          if (kind === "artifact_set") add(check, { kind, artifact_set_hash: input.artifact_set_hash });
          if (kind === "source") {
            if (!artifact.source_ids.length) throw new CheckPreparationError("empty_targets");
            for (const evidence_id of artifact.source_ids) add(check, { kind, evidence_id });
          }
          if (kind === "claim") {
            if (!artifact.claim_ids.length) throw new CheckPreparationError("empty_targets");
            for (const claim_id of artifact.claim_ids) add(check, { kind, artifact_id: artifact.artifact_id, revision: artifact.revision, claim_id });
          }
        }
      }
    }
    for (const requirement of requirements) {
      if ((counts.get(requirement.artifact_kind) ?? 0) < requirement.minimum_count) throw new CheckPreparationError("invalid_bounds");
    }
    if (!entries.size || entries.size > capacity) throw new CheckPreparationError("capacity_exceeded");
    const checks = [...entries.values()].sort((a, b) => compareUtf8(matrixKey(a), matrixKey(b)));
    const projection = freezePreparation({ protocol: "onisall.required-check-matrix.v1" as const,
      plan_sha256: planSha256, artifact_set_hash: input.artifact_set_hash, checks });
    return Object.freeze({ projection, requiredMatrixHash: preparationHash(projection) });
  }

  return Object.freeze({
    manifest, planSha256, expand,
    assertCoverage(raw: ArtifactTargetInventory, candidates: readonly RequiredMatrixEntry[]): void {
      const supplied = parsePreparation(z.array(matrixEntry).min(1).max(MAX_REQUIRED_CHECKS), candidates);
      unique(supplied, matrixKey);
      const expected = expand(raw).projection.checks;
      supplied.sort((a, b) => compareUtf8(matrixKey(a), matrixKey(b)));
      if (preparationJson(expected) !== preparationJson(supplied)) throw new CheckPreparationError("matrix_mismatch");
    },
  });
}
