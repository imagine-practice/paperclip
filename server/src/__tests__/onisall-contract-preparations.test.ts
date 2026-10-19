import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, companies, companyMemberships, projects, projectAccessMembers, activityLog,
  pipelineCases, heartbeatRuns, onisallContractPreparations as preparations,
  onisallFrozenSchemaSets } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { onisallContractPreparationService, type TrustedContractPreparationInput } from "../services/onisall/contract-preparations.js";
import { onisallFrozenSchemaSetService } from "../services/onisall/frozen-schema-sets.js";
import { onisallFrozenRuleSetService, readFrozenRuleSetInTransaction } from "../services/onisall/frozen-rule-sets.js";
import { createContractPreflight } from "../services/onisall/contract-preflight.js";
import { onisallIntakeDraftService } from "../services/onisall/intake-drafts.js";
import { onisallNativeBindingService } from "../services/onisall/native-bindings.js";
import { createOfflineSchemaRegistry } from "../services/onisall/schema-registry.js";
import { pipelineService } from "../services/pipelines.js";
import { companyService } from "../services/companies.js";
import { sha256 } from "../services/onisall/input-snapshot.js";
import type { StorageService } from "../storage/types.js";
import type { AuthorizationActor } from "../services/authorization.js";

const compiler = vi.hoisted(() => ({ changed: false }));
vi.mock("../services/onisall/schema-compiler.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/onisall/schema-compiler.js")>();
  return { ...actual, SCHEMA_COMPILER_PROFILE: new Proxy({ ...actual.SCHEMA_COMPILER_PROFILE }, {
    get(target, property, receiver) { return property === "ajvVersion" && compiler.changed ? "simulated-future" : Reflect.get(target, property, receiver); }
  }) };
});

const support = await getEmbeddedPostgresTestSupport();
const owner: AuthorizationActor = { type: "board", source: "local_implicit", userId: "owner" };
const json = (v: unknown) => Buffer.from(JSON.stringify(v));
const pin = (key: string, bytes: Buffer) => ({ ref: { registry_key: key, revision: "1", sha256: sha256(bytes) }, bytes });
function memoryStorage() {
  const objects = new Map<string, Buffer>();
  let beforeRead: (() => Promise<void>) | undefined;
  const storage: StorageService = { provider: "local_disk", async putFile(input) {
    if (!Buffer.isBuffer(input.body) || !input.objectKey) throw new Error("Unexpected fixture bytes");
    objects.set(input.objectKey, Buffer.from(input.body));
    return { provider: "local_disk", objectKey: input.objectKey, byteSize: input.body.length, sha256: sha256(input.body), contentType: input.contentType, originalFilename: null };
  }, async getObject(_company, key) {
    await beforeRead?.(); const bytes = objects.get(key); if (!bytes) throw new Error("Private injected missing object");
    return { stream: Readable.from([Buffer.from(bytes)]) };
  }, async headObject(_company, key) { return { exists: objects.has(key) }; }, async deleteObject(_company, key) { objects.delete(key); } };
  return { objects, storage, intercept: (hook?: () => Promise<void>) => { beforeRead = hook; } };
}
(support.supported ? describe : describe.skip)("Contract preparations: temporary PostgreSQL and synthetic rule/storage fixtures", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { fixture = await startEmbeddedPostgresTestDatabase("onisall-contract-prepare-"); db = createDb(fixture.connectionString); }, 30000);
  afterEach(async () => { compiler.changed = false; for (const company of await db.select().from(companies)) await companyService(db).remove(company.id); });
  afterAll(async () => { await fixture?.cleanup(); });
  async function setup(privateProject = false) {
    const [company] = await db.insert(companies).values({ name: "Contract preparation fixture", issuePrefix: randomUUID().slice(0, 8), defaultResponsibleUserId: "owner" }).returning();
    const project = privateProject ? (await db.insert(projects).values({ companyId: company!.id, name: "Private", visibility: "private", privacyOwnerUserId: "owner" }).returning())[0]! : null;
    if (project) await db.insert(projectAccessMembers).values({ companyId: company!.id, projectId: project.id, subjectType: "user", subjectId: "owner" });
    const store = memoryStorage(), native = pipelineService(db, { heartbeat: { wakeup: async () => null } });
    const pipeline = await native.createPipeline({ companyId: company!.id, key: "fixture", name: "Fixture", projectId: project?.id ?? null, actor: { type: "user", userId: "owner" } });
    const intake = onisallIntakeDraftService(db, store.storage, owner);
    const { draft } = await intake.create(company!.id, "owner", { requestKey: "input", goal: "Synthetic requirement", sourceLabel: "Synthetic", contentBase64: Buffer.from("Synthetic UTF-8\r\ninput\n").toString("base64") });
    const binding = onisallNativeBindingService(db, store.storage, owner);
    const context = await binding.context(company!.id, draft.id, { pipelineId: pipeline.id, entryStageKey: "intake" });
    const { binding: bound } = await binding.bind(company!.id, draft.id, { pipelineId: context.pipelineId, projectId: context.projectId, entryStageKey: context.entryStageKey, inputSha256: context.inputSha256, configurationHash: context.configurationHash });
    const { baseline } = await intake.createPreparationBaseline(company!.id, draft.id, { requestKey: "baseline" });
    // Factory/DB orchestration fixture only. Complete authoritative v3 bytes are exercised by the root live observer.
    const contractSchema = pin("fixture/contract", json({ $id: "urn:onisall:paperclip:capability-contracts:3", type: "object",
      required: ["kind", "schema_version", "contract_id", "revision", "status", "artifact_requirements", "verification_commands", "limits"],
      properties: { kind: { const: "task_contract" }, schema_version: { const: 3 }, status: { const: "published" }, revision: { const: 1 } } }));
    const artifactSchema = pin("fixture/artifact", json({ type: "object" }));
    const { set: schemas } = await onisallFrozenSchemaSetService(db, owner).freeze(company!.id, createOfflineSchemaRegistry([contractSchema, artifactSchema]), [contractSchema.ref, artifactSchema.ref]);
    const validatorBytes = Buffer.from("Synthetic validator; never executed"), check = { check_id: "fixture/check", revision: "1", validator_sha256: sha256(validatorBytes) };
    const runtime = pin("fixture/runtime", Buffer.from("Synthetic runtime; never executed"));
    const policy = pin("fixture/policy", json({ protocol: "onisall.check-sandbox.v1", network: "deny", workspace: "read_only", environment: "empty", child_processes: "deny" }));
    const command = pin("fixture/command", json({ protocol: "onisall.verification-command.v1", validator: check, runtime_ref: runtime.ref,
      argv: ["$VALIDATOR"], cwd: "isolated_artifact_workspace", shell: false, timeout_ms: 1000, sandbox_policy_ref: policy.ref }));
    const { set: rules } = await onisallFrozenRuleSetService(db, store.storage, owner).freeze(company!.id, { schemaSetId: schemas.id,
      checks: [{ descriptor: { check, target_kinds: ["artifact"], evidence_mode: "machine" }, validatorBytes }], commands: [command], runtimes: [runtime], policies: [policy] });
    const fields = { capability_allowlist: [], source_allowlist: [], artifact_requirements: [{ artifact_kind: "report_json", minimum_count: 1, schema_ref: artifactSchema.ref, required_checks: [check] }],
      limits: { max_execution_seconds: 1 }, verification_commands: [{ command_id: "fixture", ref: command.ref, validator: check }] };
    const input: TrustedContractPreparationInput = { requestKey: "candidate", baselineId: baseline.id, ruleSetId: rules.id, contractSchemaRef: contractSchema.ref,
      fieldsBytes: json(fields), outputBounds: [{ artifact_kind: "report_json", max_count: 1, max_sources_per_artifact: 0, max_claims_per_artifact: 0 }] };
    const service = onisallContractPreparationService(db, store.storage, owner);
    return { company: company!, project, pipeline, draft, bound, baseline, schemas, rules, input, fields, service, intake, native, ...store };
  }
  async function prepare() { const f = await setup(); return { ...f, result: await f.service.prepare(f.company.id, f.draft.id, f.input) }; }
  it("persists full candidate bytes, binds real scope and never creates business execution", async () => {
    const f = await prepare(); const [row] = await db.select().from(preparations);
    expect(f.result.preparation).toMatchObject({ integrity: "verified", current: { status: "matches" }, preflight: { status: "verified", maximumChecks: 1 }, publication: { executionAdmission: "not_granted" } });
    expect(JSON.parse(row!.candidate)).toMatchObject({ status: "published", goal: f.draft.goal, contract_id: row!.contractId,
      scope: { company_id: f.company.id, case_id: f.bound.caseId, issue_id: null, client_id: null, project_id: null } });
    for (const [content, digest] of [[row!.candidate, row!.candidateSha256], [row!.preflight, row!.preflightSha256], [row!.dependencies, row!.dependenciesSha256], [row!.checkPlan, row!.checkPlanSha256]]) expect(sha256(Buffer.from(content))).toBe(digest);
    expect(row!.acceptanceCriteriaHash).not.toBe(row!.candidateSha256);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect((await f.intake.get(f.company.id, f.draft.id)).contractId).toBeNull();
    expect((await db.select().from(pipelineCases))[0]!.version).toBe(f.baseline.caseVersion);
    for (const key of ["candidate", "fields", "requestPayload", "argv", "provider", "objectKey", "createdByUserId"]) expect(JSON.stringify(f.result.preparation)).not.toContain(`"${key}"`);
  });
  it("serializes four same-key preparations to one candidate and audit", async () => {
    const f = await setup(); const results = await Promise.all(Array.from({ length: 4 }, () => f.service.prepare(f.company.id, f.draft.id, f.input)));
    expect(new Set(results.map(r => r.preparation.preparation.id)).size).toBe(1); expect(results.filter(r => !r.replayed)).toHaveLength(1);
    expect(await db.select().from(preparations)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "onisall.contract_preparation.created"))).toHaveLength(1);
  });
  it("rejects same-key different fields or bounds without overwriting history", async () => {
    const f = await prepare();
    await expect(f.service.prepare(f.company.id, f.draft.id, { ...f.input, fieldsBytes: json({ ...f.fields, capability_allowlist: ["other"] }) })).rejects.toMatchObject({ status: 409 });
    await expect(f.service.prepare(f.company.id, f.draft.id, { ...f.input, outputBounds: [{ ...f.input.outputBounds[0]!, max_count: 2 }] })).rejects.toMatchObject({ status: 409 });
    expect((await f.service.get(f.company.id, f.draft.id, f.result.preparation.preparation.id)).preparation).toEqual(f.result.preparation.preparation);
  });
  it("does not treat the acceptance projection as authority for capabilities or execution limits", async () => {
    const f = await prepare(); const [row] = await db.select().from(preparations);
    const changed = JSON.parse(row!.candidate); changed.capability_allowlist = ["changed-capability"]; changed.limits.max_execution_seconds = 2;
    const rules = await db.transaction(tx => readFrozenRuleSetInTransaction(tx, f.storage, f.company.id, f.rules.id), { isolationLevel: "repeatable read", accessMode: "read only" });
    const actual = createContractPreflight({ contractSchemaRef: f.input.contractSchemaRef, schemas: rules.schemas, checks: rules.checks, commands: rules.commands }).inspect(json(changed), f.input.outputBounds);
    expect(actual.snapshot.acceptance_criteria_hash).toBe(row!.acceptanceCriteriaHash);
    expect(actual.snapshot.candidate_bytes_sha256).not.toBe(row!.candidateSha256);
    expect(actual.snapshotSha256).not.toBe(row!.preflightSha256);
    await expect(f.service.prepare(f.company.id, f.draft.id, { ...f.input, fieldsBytes: json({ ...f.fields, capability_allowlist: changed.capability_allowlist, limits: changed.limits }) })).rejects.toMatchObject({ status: 409 });
  });
  it.each(["scope", "contract_id", "revision", "status", "goal", "business_key"])("refuses caller-owned reserved field %s before any record", async key => {
    const f = await setup(); await expect(f.service.prepare(f.company.id, f.draft.id, { ...f.input, fieldsBytes: json({ ...f.fields, [key]: "forged" }) })).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(preparations)).toHaveLength(0);
  });
  it("rejects missing checks, unregistered contract Schema and over-capacity output", async () => {
    const f = await setup();
    for (const input of [{ ...f.input, fieldsBytes: json({ ...f.fields, verification_commands: [] }) },
      { ...f.input, contractSchemaRef: { ...f.input.contractSchemaRef, sha256: "0".repeat(64) } },
      { ...f.input, outputBounds: [{ ...f.input.outputBounds[0]!, max_count: 501 }] }]) await expect(f.service.prepare(f.company.id, f.draft.id, input)).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(preparations)).toHaveLength(0);
  });
  it("rejects duplicate JSON fields, malformed UTF-8 and oversized candidate input", async () => {
    const f = await setup(); for (const bytes of [Buffer.from('{"limits":{},"limits":{}}'), Buffer.from([255]), Buffer.alloc(1048577)]) await expect(f.service.prepare(f.company.id, f.draft.id, { ...f.input, fieldsBytes: bytes })).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(preparations)).toHaveLength(0);
  });
  it.each(["candidate", "dependencies", "preflight", "checkPlan", "requestPayload"])("refuses stored %s corruption, while catalog makes no integrity claim", async field => {
    const f = await prepare(); const id = f.result.preparation.preparation.id;
    await db.update(preparations).set({ [field]: "{}", ...(field === "candidate" ? { candidateByteSize: 2 } : {}) }).where(eq(preparations.id, id));
    expect((await f.service.list(f.company.id, f.draft.id)).preparations).toHaveLength(1);
    await expect(f.service.get(f.company.id, f.draft.id, id)).rejects.toMatchObject({ status: 409 });
    await expect(f.service.prepare(f.company.id, f.draft.id, f.input)).rejects.toMatchObject({ status: 409 });
  });
  it.each(["input", "rule"])("rejects actual %s byte damage without exposing private errors", async kind => {
    const f = await prepare(), id = f.result.preparation.preparation.id;
    const key = kind === "input" ? [...f.objects.keys()].find(k => k.includes("onisall-inputs"))! : [...f.objects.keys()].find(k => k.includes("onisall-rules"))!;
    f.objects.delete(key);
    await expect(f.service.get(f.company.id, f.draft.id, id)).rejects.toMatchObject({ status: 409 });
  });
  it("separates workflow drift from historical integrity and preserves native Case version", async () => {
    const f = await prepare(), id = f.result.preparation.preparation.id;
    const working = f.pipeline.stages.find(s => s.key === "in_progress")!;
    await f.native.updateStage({ companyId: f.company.id, pipelineId: f.pipeline.id, stageId: working.id, patch: { name: "Changed" } });
    const changed = await f.service.get(f.company.id, f.draft.id, id);
    expect(changed).toMatchObject({ integrity: "verified", preflight: { status: "verified" }, current: { status: "changed" } });
    expect(changed.current.changes).toContain("workflow_changed");
    expect((await db.select().from(pipelineCases))[0]!.version).toBe(f.baseline.caseVersion);
    expect((await f.service.prepare(f.company.id, f.draft.id, f.input)).replayed).toBe(true);
    await expect(f.service.prepare(f.company.id, f.draft.id, { ...f.input, requestKey: "new" })).rejects.toMatchObject({ status: 409 });
  });
  it("detects inserted transition without assuming Case version covers workflow", async () => {
    const f = await prepare(); const stages = f.pipeline.stages;
    await f.native.createTransition({ companyId: f.company.id, pipelineId: f.pipeline.id, fromStageId: stages[0]!.id, toStageId: stages.find(s => s.kind === "cancelled")!.id });
    expect((await f.service.get(f.company.id, f.draft.id, f.result.preparation.preparation.id)).current.changes).toContain("workflow_changed");
  });
  it("rejects upstream manifest mutation even when its own digest is recomputed", async () => {
    const f = await prepare(); const [row] = await db.select().from(onisallFrozenSchemaSets).where(eq(onisallFrozenSchemaSets.id, f.schemas.id));
    const manifest = JSON.parse(row!.manifest); manifest.compiler.ajvVersion = "future";
    // Changing upstream frozen material breaks the preparation dependency, even if its own hash is recomputed.
    const content = JSON.stringify(manifest);
    await db.update(onisallFrozenSchemaSets).set({ manifest: content, manifestSha256: sha256(Buffer.from(content)) }).where(eq(onisallFrozenSchemaSets.id, f.schemas.id));
    await expect(f.service.get(f.company.id, f.draft.id, f.result.preparation.preparation.id)).rejects.toMatchObject({ status: 409 });
  });
  it("reports changed deployed compiler separately without rewriting historical bytes", async () => {
    const f = await prepare(), id = f.result.preparation.preparation.id;
    const before = await db.select().from(preparations); compiler.changed = true;
    expect(await f.service.get(f.company.id, f.draft.id, id)).toMatchObject({ integrity: "verified", preflight: { status: "profile_changed" },
      current: { status: "changed", changes: ["compiler_profile_changed"] } });
    await expect(f.service.prepare(f.company.id, f.draft.id, { ...f.input, requestKey: "future" })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(preparations)).toEqual(before); compiler.changed = false;
    expect((await f.service.get(f.company.id, f.draft.id, id)).preflight.status).toBe("verified");
  });
  it("rolls back the candidate if its native audit insertion fails", async () => {
    const f = await setup();
    await db.execute(sql`CREATE FUNCTION ons27_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$`);
    await db.execute(sql`CREATE TRIGGER ons27_reject_audit BEFORE INSERT ON activity_log FOR EACH ROW WHEN (NEW.action = 'onisall.contract_preparation.created') EXECUTE FUNCTION ons27_reject_audit()`);
    try {
      await expect(f.service.prepare(f.company.id, f.draft.id, f.input)).rejects.toBeDefined();
      expect(await db.select().from(preparations)).toHaveLength(0);
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "onisall.contract_preparation.created"))).toHaveLength(0);
    } finally { await db.execute(sql`DROP TRIGGER ons27_reject_audit ON activity_log`); await db.execute(sql`DROP FUNCTION ons27_reject_audit()`); }
    expect((await f.service.prepare(f.company.id, f.draft.id, f.input)).replayed).toBe(false);
  });
  it("rejects foreign company or same-company other-intake baselines and exact relationship mismatches", async () => {
    const f = await prepare(), other = await setup();
    await expect(f.service.get(other.company.id, f.draft.id, f.result.preparation.preparation.id)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.prepare(f.company.id, f.draft.id, { ...f.input, requestKey: "foreign", baselineId: other.baseline.id })).rejects.toMatchObject({ status: 404 });
    const { draft } = await f.intake.create(f.company.id, "owner", { requestKey: "other-input", goal: "Other", sourceLabel: "Other", contentBase64: Buffer.from("Other").toString("base64") });
    await expect(f.service.prepare(f.company.id, draft.id, { ...f.input, requestKey: "wrong-intake" })).rejects.toMatchObject({ status: 404 });
    await expect(db.update(preparations).set({ baselineId: other.baseline.id })).rejects.toBeDefined();
    await expect(db.update(preparations).set({ executionAdmission: "granted" })).rejects.toBeDefined();
  });
  it("uses current membership and private Project visibility before reading rule/input bytes", async () => {
    const f = await setup(true); const result = await f.service.prepare(f.company.id, f.draft.id, f.input);
    const viewer: AuthorizationActor = { type: "board", source: "session", userId: "viewer", companyIds: [f.company.id] };
    await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: "viewer", membershipRole: "viewer", status: "active" });
    const service = onisallContractPreparationService(db, f.storage, viewer); let reads = 0; f.intercept(async () => { reads++; });
    await expect(service.get(f.company.id, f.draft.id, result.preparation.preparation.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.list(f.company.id, f.draft.id)).rejects.toMatchObject({ status: 404 }); expect(reads).toBe(0);
    await db.insert(projectAccessMembers).values({ companyId: f.company.id, projectId: f.project!.id, subjectType: "user", subjectId: "viewer" });
    expect((await service.get(f.company.id, f.draft.id, result.preparation.preparation.id)).integrity).toBe("verified");
    await expect(service.prepare(f.company.id, f.draft.id, f.input)).rejects.toMatchObject({ status: 403 });
    await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.principalId, "viewer"));
    await expect(service.get(f.company.id, f.draft.id, result.preparation.preparation.id)).rejects.toMatchObject({ status: 403 });
  });
  it("keeps paused/archived records read-only and rejects Agent/delegated callers", async () => {
    const f = await prepare();
    for (const status of ["paused", "archived"]) {
      await db.update(companies).set({ status }).where(eq(companies.id, f.company.id));
      expect((await f.service.get(f.company.id, f.draft.id, f.result.preparation.preparation.id)).current.changes).toContain("company_inactive");
      await expect(f.service.prepare(f.company.id, f.draft.id, f.input)).rejects.toMatchObject({ status: 409 });
    }
    for (const actor of [{ type: "agent", agentId: randomUUID(), companyId: f.company.id }, { ...owner, source: "mcp_oauth" }] as AuthorizationActor[]) await expect(onisallContractPreparationService(db, f.storage, actor).list(f.company.id, f.draft.id)).rejects.toMatchObject({ status: 403 });
  });
  it("reads a single DB snapshot and detects concurrent candidate damage on the following read", async () => {
    const f = await prepare(), id = f.result.preparation.preparation.id; let arrive!: () => void, release!: () => void;
    const reached = new Promise<void>(r => { arrive = r; }), wait = new Promise<void>(r => { release = r; });
    let once = true; f.intercept(async () => { if (once) { once = false; arrive(); await wait; } });
    const reading = f.service.get(f.company.id, f.draft.id, id); await reached;
    await db.update(preparations).set({ candidate: "{}", candidateByteSize: 2 }).where(eq(preparations.id, id)); release();
    expect((await reading).integrity).toBe("verified"); f.intercept();
    await expect(f.service.get(f.company.id, f.draft.id, id)).rejects.toMatchObject({ status: 409 });
  });
  it("cleans preparation references before native company deletion and preserves another company's history", async () => {
    const f = await prepare(), other = await prepare(); await companyService(db).remove(f.company.id);
    expect(await db.select().from(preparations).where(eq(preparations.companyId, f.company.id))).toHaveLength(0);
    expect((await other.service.get(other.company.id, other.draft.id, other.result.preparation.preparation.id)).integrity).toBe("verified");
  });
});
