import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { companies, onisallContractPreparations as preparations, type Db } from "@paperclipai/db";
import type { OnisallContractPreparation, OnisallContractPreparationCatalog, OnisallContractPreparationStatus,
  OnisallContractPreparationChange, OnisallPreparationBaseline } from "@paperclipai/shared";
import type { StorageService } from "../../storage/types.js";
import { conflict, forbidden, notFound, unprocessable } from "../../errors.js";
import { authorizationService, type AuthorizationActor } from "../authorization.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import { assertBindingProjectVisible, readIntakeBinding } from "./binding-view.js";
import { readIntakePreparationInTransaction } from "./intake-drafts.js";
import { readPreparationBaselineInTransaction, preparationBaselineStatusInTransaction } from "./preparation-baselines.js";
import { readFrozenRuleSetInTransaction } from "./frozen-rule-sets.js";
import { readFrozenSchemaSetInTransaction } from "./frozen-schema-sets.js";
import { createContractPreflight } from "./contract-preflight.js";
import { parseStrictJson, STRICT_JSON_LIMITS } from "./strict-json.js";
import { preparationJson } from "./check-registry.js";
import { pinnedAssetRef } from "./command-registry.js";
import { sha256 } from "./input-snapshot.js";
import type { PinnedSchemaRef } from "./schema-registry.js";
import type { MatrixPreparationInput } from "./required-check-matrix.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Row = typeof preparations.$inferSelect;
const summaryColumns = { id: preparations.id, companyId: preparations.companyId, intakeId: preparations.intakeId,
  baselineId: preparations.baselineId, ruleSetId: preparations.ruleSetId, contractId: preparations.contractId,
  candidateSha256: preparations.candidateSha256, candidateByteSize: preparations.candidateByteSize,
  dependenciesSha256: preparations.dependenciesSha256, acceptanceCriteriaHash: preparations.acceptanceCriteriaHash,
  checkPlanSha256: preparations.checkPlanSha256, preflightSha256: preparations.preflightSha256, createdAt: preparations.createdAt };
const uuid = z.string().uuid();
const bound = z.strictObject({ artifact_kind: z.enum(["evidence_set", "change_set", "report_json", "report_html", "report_pdf", "code_result"]),
  max_count: z.number().int().min(0).max(1000), max_sources_per_artifact: z.number().int().min(0).max(10000), max_claims_per_artifact: z.number().int().min(0).max(10000) });
const requestShape = z.strictObject({ protocol: z.literal("onisall.contract-preparation-request.v1"),
  baselineId: uuid, ruleSetId: uuid, contractSchemaRef: pinnedAssetRef,
  fields: z.record(z.string(), z.unknown()), outputBounds: z.array(bound).min(1).max(6) });
const configurable = new Set(["capability_allowlist", "source_allowlist", "artifact_requirements", "limits", "approval_policy",
  "policy_revision", "protected_paths", "verification_commands", "risk_level"]);
export interface TrustedContractPreparationInput {
  requestKey: string; baselineId: string; ruleSetId: string; contractSchemaRef: PinnedSchemaRef;
  // Strict UTF-8 JSON for only the configurable fields, never scope/identity/status.
  fieldsBytes: Uint8Array; outputBounds: MatrixPreparationInput["output_bounds"];
}
function decodeRequest(input: TrustedContractPreparationInput) {
  try {
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).parse(input.requestKey);
    if (!(input.fieldsBytes instanceof Uint8Array)) throw new Error("Invalid bytes");
    const fields = parseStrictJson(Buffer.from(input.fieldsBytes));
    if (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.keys(fields).some(k => !configurable.has(k))) throw new Error("Reserved fields");
    const value = requestShape.parse({ protocol: "onisall.contract-preparation-request.v1", baselineId: input.baselineId,
      ruleSetId: input.ruleSetId, contractSchemaRef: input.contractSchemaRef, fields, outputBounds: input.outputBounds });
    const payload = preparationJson(value);
    if (Buffer.byteLength(payload) > STRICT_JSON_LIMITS.bytes) throw new Error("Request limit");
    return { value, payload, digest: sha256(Buffer.from(payload)) };
  } catch { throw unprocessable("Trusted contract preparation is invalid or exceeds limits"); }
}
function candidate(request: z.infer<typeof requestShape>, contractId: string,
  draft: Awaited<ReturnType<typeof readIntakePreparationInTransaction>>["draft"], baseline: OnisallPreparationBaseline) {
  return preparationJson({ ...request.fields, kind: "task_contract", schema_version: 3, status: "published",
    contract_id: contractId, revision: 1, binding_revision: baseline.bindingRevision, goal: draft.goal, business_key: draft.businessKey,
    control_mode: "native_pipeline", scope: { company_id: draft.companyId, client_id: null,
      project_id: baseline.projectId, issue_id: null, case_id: baseline.caseId } });
}
function dto(row: Pick<Row, keyof typeof summaryColumns>): OnisallContractPreparation {
  return { protocol: "onisall.contract-preparation.v1", id: row.id, companyId: row.companyId, intakeId: row.intakeId,
    baselineId: row.baselineId, ruleSetId: row.ruleSetId, contractId: row.contractId, contractRevision: 1,
    candidateSha256: row.candidateSha256, candidateByteSize: row.candidateByteSize, dependenciesSha256: row.dependenciesSha256,
    acceptanceCriteriaHash: row.acceptanceCriteriaHash, checkPlanSha256: row.checkPlanSha256, preflightSha256: row.preflightSha256,
    purpose: "preparation", executionAdmission: "not_granted", createdAt: row.createdAt.toISOString() };
}
function dependencies(baseline: OnisallPreparationBaseline, rules: Awaited<ReturnType<typeof readFrozenRuleSetInTransaction>>,
  schemas: Awaited<ReturnType<typeof readFrozenSchemaSetInTransaction>>, ref: PinnedSchemaRef) {
  return preparationJson({ protocol: "onisall.contract-dependencies.v1", baseline,
    rules: { id: rules.status.set.id, manifest_sha256: rules.status.set.manifestSha256 },
    schemas: { id: schemas.status.set.id, manifest_sha256: schemas.status.set.manifestSha256,
      compiler_profile_sha256: schemas.status.set.compiler.profileSha256 }, contract_schema: ref });
}
function readRecord(row: Row) {
  try {
    if (row.purpose !== "preparation" || row.executionAdmission !== "not_granted" || row.contractRevision !== 1
      || Buffer.byteLength(row.candidate) !== row.candidateByteSize
      || [[row.requestPayload, row.requestHash], [row.candidate, row.candidateSha256], [row.dependencies, row.dependenciesSha256],
        [row.preflight, row.preflightSha256], [row.checkPlan, row.checkPlanSha256]].some(([bytes, digest]) => sha256(Buffer.from(bytes!)) !== digest)) throw new Error("Stored hash");
    const request = requestShape.parse(parseStrictJson(Buffer.from(row.requestPayload)));
    if (Object.keys(request.fields).some(k => !configurable.has(k)) || request.baselineId !== row.baselineId || request.ruleSetId !== row.ruleSetId) throw new Error("Stored request");
    const parsed = parseStrictJson(Buffer.from(row.candidate)) as Record<string, unknown>;
    const preflight = parseStrictJson(Buffer.from(row.preflight)) as Record<string, unknown>;
    const plan = z.object({ protocol: z.literal("onisall.required-check-plan.v1"), maximum_checks: z.number().int().min(1).max(500),
      artifact_requirements: z.array(z.object({ artifact_kind: z.string() }).passthrough()).min(1).max(6) }).passthrough().parse(parseStrictJson(Buffer.from(row.checkPlan)));
    if (parsed.contract_id !== row.contractId || parsed.revision !== 1 || parsed.status !== "published"
      || preflight.protocol !== "onisall.contract-preflight.v1" || preflight.status !== "offline_prepared" || preflight.execution_admission !== "not_granted"
      || preflight.contract_id !== row.contractId || preflight.contract_revision !== 1 || preflight.candidate_bytes_sha256 !== row.candidateSha256
      || preflight.acceptance_criteria_hash !== row.acceptanceCriteriaHash || preflight.required_check_plan_sha256 !== row.checkPlanSha256) throw new Error("Stored preflight");
    return { request, plan };
  } catch { throw conflict("Stored contract preparation differs"); }
}

export function onisallContractPreparationService(db: Db, storage: StorageService, actor: AuthorizationActor) {
  async function authorize(conn: Db | Tx, companyId: string, write: boolean) {
    if (actor.type !== "board" || !actor.userId || actor.source === "mcp_oauth") throw forbidden("Direct board session required");
    const permission = await authorizationService(conn as Db).decide({ actor, action: write ? "pipelines:write" : "company_scope:read",
      resource: { type: "company", companyId } });
    if (!permission.allowed) throw forbidden("Current company preparation access required");
    return actor.userId;
  }
  async function readScopedRow(tx: Tx, companyId: string, intakeId: string, summary: Pick<Row, "id" | "baselineId">) {
    await readPreparationBaselineInTransaction(tx, companyId, intakeId, summary.baselineId, actor);
    await readIntakeBinding(tx, companyId, intakeId, actor);
    const [row] = await tx.select().from(preparations).where(and(eq(preparations.companyId, companyId), eq(preparations.intakeId, intakeId), eq(preparations.id, summary.id)));
    if (!row) throw notFound("Contract preparation not found");
    return row;
  }
  async function load(tx: Tx, companyId: string, intakeId: string, row: Row): Promise<OnisallContractPreparationStatus> {
    // Historical Project scope is enforced before reading any candidate/assets.
    const baseline = await readPreparationBaselineInTransaction(tx, companyId, intakeId, row.baselineId, actor);
    await readIntakeBinding(tx, companyId, intakeId, actor);
    const { request, plan } = readRecord(row);
    const rules = await readFrozenRuleSetInTransaction(tx, storage, companyId, row.ruleSetId);
    const schemas = await readFrozenSchemaSetInTransaction(tx, companyId, rules.status.set.schemaSetId);
    try { rules.schemas.resolve(request.contractSchemaRef); }
    catch { throw conflict("Stored contract Schema reference differs"); }
    const source = await readIntakePreparationInTransaction(tx, storage, companyId, intakeId, actor);
    if (row.dependencies !== dependencies(baseline, rules, schemas, request.contractSchemaRef)
      || row.candidate !== candidate(request, row.contractId, source.draft, baseline)) throw conflict("Stored contract dependency or scope differs");
    const matches = schemas.status.currentCompiler.matchesFrozenProfile;
    if (matches) {
      let actual: ReturnType<ReturnType<typeof createContractPreflight>["inspect"]>;
      try { actual = createContractPreflight({ contractSchemaRef: request.contractSchemaRef, schemas: rules.schemas,
        checks: rules.checks, commands: rules.commands }).inspect(Buffer.from(row.candidate), request.outputBounds); }
      catch { throw conflict("Stored contract preflight no longer verifies"); }
      if (preparationJson(actual.snapshot) !== row.preflight || preparationJson(actual.matrix.manifest) !== row.checkPlan
        || actual.snapshotSha256 !== row.preflightSha256 || actual.snapshot.acceptance_criteria_hash !== row.acceptanceCriteriaHash) throw conflict("Stored contract preflight differs");
    }
    const comparison = await preparationBaselineStatusInTransaction(tx, source.preparation, actor, row.baselineId);
    const changes: OnisallContractPreparationChange[] = [...comparison.comparison.changes];
    if (source.companyStatus !== "active") changes.push("company_inactive");
    if (!matches) changes.push("compiler_profile_changed");
    return { protocol: "onisall.contract-preparation-status.v1", evaluatedAt: new Date().toISOString(), diagnosticsOnly: true,
      integrity: "verified", preparation: dto(row), current: { status: changes.length ? "changed" : "matches", changes: [...new Set(changes)] },
      preflight: { status: matches ? "verified" : "profile_changed", maximumChecks: plan.maximum_checks,
        artifactKinds: plan.artifact_requirements.map(r => r.artifact_kind) },
      publication: { status: "unavailable", executionAdmission: "not_granted" },
      qualification: { sandbox: "not_evaluated", businessAcceptance: "not_evaluated", independentReview: "not_evaluated" } };
  }
  return {
    // Trusted deployment composition only. No HTTP/Agent creation endpoint.
    async prepare(companyId: string, intakeId: string, input: TrustedContractPreparationInput) {
      const decoded = decodeRequest(input);
      const save = () => db.transaction(async tx => {
        const userId = await authorize(tx, companyId, true);
        const [company] = await tx.select().from(companies).where(eq(companies.id, companyId)).for("share");
        if (!company) throw notFound("Company not found");
        if (company.status !== "active") throw conflict("Company is not active");
        // Only this preparation command is serialized. This is NOT a native workflow/publication lock.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`onisall-contract-prepare:${companyId}:${intakeId}:${input.requestKey}`}, 0))`);
        const [summary] = await tx.select(summaryColumns).from(preparations).where(and(eq(preparations.companyId, companyId), eq(preparations.intakeId, intakeId), eq(preparations.requestKey, input.requestKey)));
        if (summary) {
          const existing = await readScopedRow(tx, companyId, intakeId, summary);
          if (existing.requestHash !== decoded.digest || existing.requestPayload !== decoded.payload) throw conflict("Preparation request key already names different content");
          return { status: await load(tx, companyId, intakeId, existing), replayed: true, publication: null };
        }
        const source = await readIntakePreparationInTransaction(tx, storage, companyId, intakeId, actor);
        const comparison = await preparationBaselineStatusInTransaction(tx, source.preparation, actor, input.baselineId);
        if (comparison.comparison.status !== "matches") throw conflict("Current input or native workflow differs from preparation baseline");
        const rules = await readFrozenRuleSetInTransaction(tx, storage, companyId, input.ruleSetId);
        const schemas = await readFrozenSchemaSetInTransaction(tx, companyId, rules.status.set.schemaSetId);
        if (!schemas.status.currentCompiler.matchesFrozenProfile) throw conflict("Frozen Schema compiler profile changed");
        const contractId = randomUUID(), bytes = candidate(decoded.value, contractId, source.draft, comparison.baseline);
        let preflight: ReturnType<ReturnType<typeof createContractPreflight>["inspect"]>;
        try { preflight = createContractPreflight({ contractSchemaRef: decoded.value.contractSchemaRef, schemas: rules.schemas,
          checks: rules.checks, commands: rules.commands }).inspect(Buffer.from(bytes), decoded.value.outputBounds); }
        catch { throw unprocessable("Candidate contract does not pass complete offline preflight"); }
        const deps = dependencies(comparison.baseline, rules, schemas, decoded.value.contractSchemaRef);
        const [row] = await tx.insert(preparations).values({ companyId, intakeId, baselineId: input.baselineId, ruleSetId: input.ruleSetId,
          contractId, requestKey: input.requestKey, requestPayload: decoded.payload, requestHash: decoded.digest,
          candidate: bytes, candidateSha256: sha256(Buffer.from(bytes)), candidateByteSize: Buffer.byteLength(bytes),
          dependencies: deps, dependenciesSha256: sha256(Buffer.from(deps)), preflight: preparationJson(preflight.snapshot),
          preflightSha256: preflight.snapshotSha256, acceptanceCriteriaHash: preflight.snapshot.acceptance_criteria_hash,
          checkPlan: preparationJson(preflight.matrix.manifest), checkPlanSha256: preflight.matrix.planSha256, createdByUserId: userId }).returning();
        const status = await load(tx, companyId, intakeId, row!);
        const publication = (await persistActivity(tx as unknown as Db, { companyId, actorType: "user", actorId: userId,
          action: "onisall.contract_preparation.created", entityType: "onisall_contract_preparation", entityId: row!.id,
          details: { intakeId, candidateSha256: row!.candidateSha256, preparationOnly: true } })).publication;
        return { status, replayed: false, publication };
      }, { isolationLevel: "repeatable read" });
      let result: Awaited<ReturnType<typeof save>> | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { result = await save(); break; }
        catch (error) {
          const cause = error instanceof Error && error.cause ? error.cause : error;
          const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : null;
          const constraint = typeof cause === "object" && cause !== null && "constraint_name" in cause ? cause.constraint_name : null;
          if (code !== "40001" && !(code === "23505" && constraint === "onisall_contract_preparations_request_uq")) throw error;
          if (attempt === 1) throw conflict("Concurrent preparation change requires fresh readback");
        }
      }
      if (!result) throw conflict("Preparation could not be committed");
      if (result.publication) publishActivity(result.publication);
      return { preparation: result.status, replayed: result.replayed };
    },
    async get(companyId: string, intakeId: string, id: string) {
      return db.transaction(async tx => {
        await authorize(tx, companyId, false);
        const [summary] = await tx.select(summaryColumns).from(preparations).where(and(eq(preparations.companyId, companyId), eq(preparations.intakeId, intakeId), eq(preparations.id, id)));
        if (!summary) throw notFound("Contract preparation not found");
        const row = await readScopedRow(tx, companyId, intakeId, summary);
        return load(tx, companyId, intakeId, row);
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
    async list(companyId: string, intakeId: string, offset = 0): Promise<OnisallContractPreparationCatalog> {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw unprocessable("Invalid preparation catalog offset");
      return db.transaction(async tx => {
        await authorize(tx, companyId, false);
        // Scope and privacy only; listing does not load/claim verified byte assets.
        const binding = await readIntakeBinding(tx, companyId, intakeId, actor);
        if (!binding) throw notFound("Bound intake not found");
        const rows = await tx.select(summaryColumns).from(preparations).where(and(eq(preparations.companyId, companyId), eq(preparations.intakeId, intakeId)))
          .orderBy(desc(preparations.createdAt), desc(preparations.id)).limit(51).offset(offset);
        for (const row of rows) {
          const baseline = await readPreparationBaselineInTransaction(tx, companyId, intakeId, row.baselineId, actor);
          await assertBindingProjectVisible(tx, companyId, baseline.projectId, actor);
        }
        return { protocol: "onisall.contract-preparation-catalog.v1", companyId, intakeId, evaluatedAt: new Date().toISOString(),
          preparations: rows.slice(0, 50).map(dto), nextOffset: rows.length > 50 ? offset + 50 : null };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
  };
}
