import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, companies, companyMemberships, activityLog, onisallRuleVersions as versions,
  onisallFrozenRuleSets as sets, onisallFrozenRuleSetMembers as members, onisallFrozenSchemaSets as schemaSets,
  onisallSchemaVersions, onisallFrozenSchemaSetMembers } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { onisallFrozenRuleSetService, readFrozenRuleSetInTransaction, type TrustedRuleSetInput } from "../services/onisall/frozen-rule-sets.js";
import { onisallFrozenSchemaSetService } from "../services/onisall/frozen-schema-sets.js";
import { createOfflineSchemaRegistry } from "../services/onisall/schema-registry.js";
import { sha256 } from "../services/onisall/input-snapshot.js";
import { preparationJson } from "../services/onisall/check-registry.js";
import { companyService } from "../services/companies.js";
import type { StorageService } from "../storage/types.js";
import type { AuthorizationActor } from "../services/authorization.js";

const support = await getEmbeddedPostgresTestSupport();
const owner: AuthorizationActor = { type: "board", source: "local_implicit", userId: "owner" };
const pin = (key: string, bytes: Buffer, revision = "1") => ({ ref: { registry_key: key, revision, sha256: sha256(bytes) }, bytes });
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
function memoryStorage() {
  const objects = new Map<string, Buffer>(); let puts = 0;
  const storage: StorageService = { provider: "local_disk", async putFile(input) {
    if (!Buffer.isBuffer(input.body) || !input.objectKey) throw new Error("Unexpected test storage input");
    puts++; objects.set(input.objectKey, Buffer.from(input.body));
    return { provider: "local_disk", objectKey: input.objectKey, contentType: input.contentType, byteSize: input.body.length,
      sha256: sha256(input.body), originalFilename: null };
  }, async getObject(_company, key) {
    const data = objects.get(key); if (!data) throw new Error("Missing fixture object");
    return { stream: Readable.from([Buffer.from(data)]), contentLength: data.length };
  }, async headObject(_company, key) { return { exists: objects.has(key) }; }, async deleteObject(_company, key) { objects.delete(key); } };
  return { storage, objects, puts: () => puts };
}
(support.supported ? describe : describe.skip)("Execution rule sets: actual temporary PostgreSQL, synthetic byte storage", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { fixture = await startEmbeddedPostgresTestDatabase("paperclip-onisall-rules-"); db = createDb(fixture.connectionString); }, 30_000);
  afterEach(async () => {
    for (const table of [members, sets, versions, onisallFrozenSchemaSetMembers, schemaSets, onisallSchemaVersions, activityLog, companyMemberships, companies]) await db.delete(table);
  });
  afterAll(async () => { await fixture?.cleanup(); });
  async function setup() {
    const [company] = await db.insert(companies).values({ name: "Rules fixture", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const schema = pin("fixture/report", json({ type: "object" }));
    const schemaSet = await onisallFrozenSchemaSetService(db, owner).freeze(company!.id, createOfflineSchemaRegistry([schema]), [schema.ref]);
    const validator = Buffer.from("ACTUAL_CHECK_BYTES");
    const check = { check_id: "fixture/check", revision: "1", validator_sha256: sha256(validator) };
    const runtime = pin("fixture/runtime", Buffer.from([0, 255, 7, 0]));
    const policy = pin("fixture/policy", json({ protocol: "onisall.check-sandbox.v1", network: "deny", workspace: "read_only", environment: "empty", child_processes: "deny" }));
    const command = pin("fixture/command", json({ protocol: "onisall.verification-command.v1", validator: check, runtime_ref: runtime.ref,
      argv: ["$VALIDATOR"], cwd: "isolated_artifact_workspace", shell: false, timeout_ms: 1000, sandbox_policy_ref: policy.ref }));
    const input: TrustedRuleSetInput = { schemaSetId: schemaSet.set.id,
      checks: [{ descriptor: { check, target_kinds: ["artifact", "source"], evidence_mode: "machine" }, validatorBytes: validator }],
      commands: [command], runtimes: [runtime], policies: [policy] };
    const store = memoryStorage(), service = onisallFrozenRuleSetService(db, store.storage, owner);
    return { company: company!, schemaSet, input, ...store, service };
  }
  async function freeze() { const f = await setup(); return { ...f, result: await f.service.freeze(f.company.id, f.input) }; }
  it("persists binary/text bytes and rebuilds existing registries without executing them", async () => {
    const f = await freeze(); expect(f.result.replayed).toBe(false); expect(f.result.set.assetCount).toBe(4);
    const loaded = await db.transaction(tx => readFrozenRuleSetInTransaction(tx, f.storage, f.company.id, f.result.set.id), { isolationLevel: "repeatable read", accessMode: "read only" });
    expect(loaded.status).toMatchObject({ diagnosticsOnly: true, integrity: "verified", preparation: { registry: "verified", schemaCompilation: "verified" },
      qualification: { sandbox: "not_evaluated", businessAcceptance: "not_evaluated" }, publication: { executionAdmission: "not_granted" } });
    const resolved = loaded.commands.resolve({ command_id: "fixture", ref: f.input.commands[0]!.ref, validator: f.input.checks[0]!.descriptor.check });
    expect(resolved.runtime_ref).toEqual(f.input.runtimes[0]!.ref);
    const [runtime] = await db.select().from(versions).where(eq(versions.kind, "runtime"));
    expect(f.objects.get(runtime!.objectKey)).toEqual(f.input.runtimes[0]!.bytes);
    const publicText = JSON.stringify(loaded.status);
    for (const key of ["objectKey", "provider", "descriptor", "manifest", "argv", "content", "createdByUserId"]) expect(publicText).not.toContain(`"${key}"`);
    expect(await f.service.list(f.company.id)).toMatchObject({ sets: [{ id: f.result.set.id }], nextOffset: null });
  });
  it("serializes four concurrent freezes to one set/audit and does not rewrite known objects", async () => {
    const f = await setup();
    const results = await Promise.all(Array.from({ length: 4 }, () => f.service.freeze(f.company.id, f.input)));
    expect(new Set(results.map(r => r.set.id)).size).toBe(1); expect(results.filter(r => !r.replayed)).toHaveLength(1);
    expect(await db.select().from(sets)).toHaveLength(1); expect(await db.select().from(versions)).toHaveLength(4); expect(f.puts()).toBe(4);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "onisall.rule_set.frozen"))).toHaveLength(1);
  });
  it("refuses descriptor replacement at a fixed revision and preserves history", async () => {
    const f = await freeze(); f.input.checks[0]!.descriptor.target_kinds = ["artifact"];
    await expect(f.service.freeze(f.company.id, f.input)).rejects.toMatchObject({ status: 409 });
    expect((await f.service.get(f.company.id, f.result.set.id)).set).toEqual(f.result.set);
    expect(await db.select().from(sets)).toHaveLength(1);
  });
  it("keeps actual new revisions separate while sharing verified immutable bytes", async () => {
    const f = await freeze(); f.input.commands[0] = { ...f.input.commands[0]!, ref: { ...f.input.commands[0]!.ref, revision: "2" } };
    const next = await f.service.freeze(f.company.id, f.input);
    expect(next.set.id).not.toBe(f.result.set.id); expect(await db.select().from(versions)).toHaveLength(5); expect(f.puts()).toBe(4);
    expect((await f.service.get(f.company.id, f.result.set.id)).set).toEqual(f.result.set);
  });
  it.each(["digest", "missing_runtime", "orphan", "duplicate", "too_many", "oversized_command", "mutable_revision", "invalid_policy", "validator_identity"])("rejects invalid %s selection with no new DB records", async failure => {
    const f = await setup();
    if (failure === "digest") f.input.runtimes[0]!.ref.sha256 = "0".repeat(64);
    if (failure === "missing_runtime") f.input.runtimes[0]!.ref.registry_key = "other";
    if (failure === "orphan") f.input.runtimes.push(pin("orphan", Buffer.from("ORPHAN")));
    if (failure === "duplicate") f.input.commands.push(f.input.commands[0]!);
    if (failure === "too_many") f.input.commands = Array(65).fill(f.input.commands[0]!);
    if (failure === "oversized_command") f.input.commands[0] = pin("huge", Buffer.alloc(65537));
    if (failure === "mutable_revision") f.input.commands[0]!.ref.revision = "latest";
    if (failure === "invalid_policy") f.input.policies[0] = pin("fixture/policy", json({ protocol: "onisall.check-sandbox.v1", network: "allow" }));
    if (failure === "validator_identity") f.input.checks[0]!.descriptor.check.check_id = "other";
    await expect(f.service.freeze(f.company.id, f.input)).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(versions)).toHaveLength(0); expect(await db.select().from(sets)).toHaveLength(0); expect(f.puts()).toBe(0);
  });
  it.each(["object_bytes", "missing_object", "manifest", "member", "descriptor", "provider", "object_key"])("rejects stored %s damage rather than returning verified", async damage => {
    const f = await freeze(); const [rule] = await db.select().from(versions).where(eq(versions.kind, "check"));
    if (damage === "object_bytes") f.objects.set(rule!.objectKey, Buffer.from("DAMAGED"));
    if (damage === "missing_object") f.objects.delete(rule!.objectKey);
    if (damage === "manifest") await db.update(sets).set({ manifest: "{}" });
    if (damage === "member") await db.delete(members).where(eq(members.position, 1));
    if (damage === "descriptor") await db.update(versions).set({ descriptor: "{}" }).where(eq(versions.id, rule!.id));
    if (damage === "provider") await db.update(versions).set({ provider: "s3" }).where(eq(versions.id, rule!.id));
    if (damage === "object_key") await db.update(versions).set({ objectKey: `${f.company.id}/onisall-rules/v1/wrong` }).where(eq(versions.id, rule!.id));
    await expect(f.service.get(f.company.id, f.result.set.id)).rejects.toMatchObject({ status: 409 });
    await expect(f.service.freeze(f.company.id, f.input)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(sets)).toHaveLength(1);
  });
  it("does not repair a damaged referenced object through a new revision", async () => {
    const f = await freeze(); const [command] = await db.select().from(versions).where(eq(versions.kind, "command"));
    f.objects.set(command!.objectKey, Buffer.from("BROKEN")); f.input.commands[0]!.ref.revision = "2";
    await expect(f.service.freeze(f.company.id, f.input)).rejects.toMatchObject({ status: 409 });
    expect(f.puts()).toBe(4); expect(f.objects.get(command!.objectKey)!.toString()).toBe("BROKEN");
    expect(await db.select().from(versions)).toHaveLength(4);
  });
  it("rolls back all DB changes when byte writes fail, retaining possible unreferenced objects", async () => {
    const f = await setup(); let count = 0; const original = f.storage.putFile;
    f.storage.putFile = async input => { if (++count === 2) throw new Error("injected private storage error"); return original(input); };
    await expect(f.service.freeze(f.company.id, f.input)).rejects.toMatchObject({ status: 409, message: "Rule byte storage write could not be verified" });
    expect(await db.select().from(versions)).toHaveLength(0); expect(await db.select().from(sets)).toHaveLength(0); expect(f.objects.size).toBe(1);
  });
  it("rolls back byte references and set on audit failure, without deleting byte objects", async () => {
    const f = await setup(); const failingDb = new Proxy(db, { get(target, key) {
      if (key === "transaction") return (work: (tx: unknown) => Promise<unknown>) => db.transaction(async tx => work(new Proxy(tx, { get(conn, member) {
        if (member === "insert") return (table: unknown) => { if (table === activityLog) throw new Error("injected-rule-audit-failure"); return conn.insert(table as typeof activityLog); };
        const value = Reflect.get(conn, member); return typeof value === "function" ? value.bind(conn) : value;
      } })));
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(onisallFrozenRuleSetService(failingDb, f.storage, owner).freeze(f.company.id, f.input)).rejects.toThrow("injected-rule-audit-failure");
    for (const table of [versions, sets, members]) expect(await db.select().from(table)).toHaveLength(0);
    expect(f.objects.size).toBe(4);
  });
  it("checks current database membership, viewer authority and paused/archive state", async () => {
    const f = await freeze();
    const viewer: AuthorizationActor = { type: "board", source: "session", userId: "viewer", companyIds: [f.company.id],
      memberships: [{ companyId: f.company.id, status: "active", membershipRole: "owner" }] };
    const svc = onisallFrozenRuleSetService(db, f.storage, viewer);
    await expect(svc.list(f.company.id)).rejects.toMatchObject({ status: 403 });
    await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: "viewer", status: "active", membershipRole: "viewer" });
    expect((await svc.get(f.company.id, f.result.set.id)).integrity).toBe("verified");
    await expect(svc.freeze(f.company.id, f.input)).rejects.toMatchObject({ status: 403 });
    await db.update(companyMemberships).set({ status: "inactive" });
    await expect(svc.get(f.company.id, f.result.set.id)).rejects.toMatchObject({ status: 403 });
    for (const status of ["paused", "archived"]) {
      await db.update(companies).set({ status }); await expect(f.service.freeze(f.company.id, f.input)).rejects.toMatchObject({ status: 409 });
      expect((await f.service.get(f.company.id, f.result.set.id)).integrity).toBe("verified");
    }
    for (const actor of [{ type: "agent", agentId: randomUUID(), companyId: f.company.id }, { ...owner, source: "mcp_oauth" }, { type: "none" }] as AuthorizationActor[]) {
      await expect(onisallFrozenRuleSetService(db, f.storage, actor).get(f.company.id, f.result.set.id)).rejects.toMatchObject({ status: 403 });
    }
  });
  it("enforces composite company/schema/member foreign keys and no grant DB shape", async () => {
    const f = await freeze(), other = await setup();
    await expect(f.service.get(other.company.id, f.result.set.id)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.freeze(other.company.id, f.input)).rejects.toMatchObject({ status: 404 });
    const [rule] = await db.select().from(versions).where(eq(versions.companyId, f.company.id));
    await expect(db.insert(members).values({ companyId: other.company.id, setId: f.result.set.id, ruleId: rule!.id, position: 0 })).rejects.toBeDefined();
    await expect(db.update(sets).set({ executionAdmission: "granted" })).rejects.toBeDefined();
    await expect(db.update(sets).set({ schemaSetId: other.schemaSet.set.id }).where(eq(sets.id, f.result.set.id))).rejects.toBeDefined();
  });
  it("allows original native company removal and preserves the other company's rules", async () => {
    const f = await freeze(), other = await freeze();
    await companyService(db).remove(f.company.id);
    expect(await db.select().from(versions).where(eq(versions.companyId, f.company.id))).toHaveLength(0);
    expect((await other.service.get(other.company.id, other.result.set.id)).integrity).toBe("verified");
    expect((await other.service.list(other.company.id)).sets).toHaveLength(1);
  });
  it("reads one database snapshot during concurrent descriptor damage and sees damage on the next read", async () => {
    const f = await freeze(); let arrived!: () => void, release!: () => void;
    const ready = new Promise<void>(r => { arrived = r; }), hold = new Promise<void>(r => { release = r; });
    const pending = db.transaction(async tx => { await tx.select().from(sets); arrived(); await hold;
      return readFrozenRuleSetInTransaction(tx, f.storage, f.company.id, f.result.set.id);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    await ready; try { await db.update(versions).set({ descriptor: "{}" }).where(eq(versions.kind, "check")); } finally { release(); }
    expect((await pending).status.integrity).toBe("verified"); await expect(f.service.get(f.company.id, f.result.set.id)).rejects.toMatchObject({ status: 409 });
  });
  it("reports historical Schema profile drift without repairing or promoting it", async () => {
    const f = await freeze(); const [schemaRow] = await db.select().from(schemaSets);
    const document = JSON.parse(schemaRow!.manifest); document.compiler.ajvVersion = "historical";
    const text = JSON.stringify(document), digest = sha256(Buffer.from(text));
    await db.update(schemaSets).set({ manifest: text, manifestSha256: digest });
    const [ruleRow] = await db.select().from(sets); const manifest = JSON.parse(ruleRow!.manifest); manifest.schema_set.manifest_sha256 = digest;
    const revised = preparationJson(manifest);
    await db.update(sets).set({ manifest: revised, manifestSha256: sha256(Buffer.from(revised)) });
    expect((await f.service.get(f.company.id, f.result.set.id)).preparation).toMatchObject({ schemaCompilerMatches: false, schemaCompilation: "profile_changed" });
    await expect(f.service.freeze(f.company.id, f.input)).rejects.toMatchObject({ status: 409 });
  });
  it("refuses nontransaction internal reads and invalid pagination", async () => {
    const f = await freeze();
    await expect(readFrozenRuleSetInTransaction(db as unknown as Parameters<typeof readFrozenRuleSetInTransaction>[0], f.storage, f.company.id, f.result.set.id)).rejects.toThrow("requires a transaction");
    await expect(f.service.list(f.company.id, -1)).rejects.toMatchObject({ status: 422 });
  });
});
