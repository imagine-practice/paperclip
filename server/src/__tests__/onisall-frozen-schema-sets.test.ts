import { randomUUID, createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, companies, companyMemberships, activityLog, onisallSchemaVersions as versions,
  onisallFrozenSchemaSets as sets, onisallFrozenSchemaSetMembers as members } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { onisallFrozenSchemaSetService, readFrozenSchemaSetInTransaction } from "../services/onisall/frozen-schema-sets.js";
import { createOfflineSchemaRegistry } from "../services/onisall/schema-registry.js";
import { freezeSchemaValidators } from "../services/onisall/schema-compiler.js";
import type { AuthorizationActor } from "../services/authorization.js";

const support = await getEmbeddedPostgresTestSupport();
const owner: AuthorizationActor = { type: "board", source: "local_implicit", userId: "owner" };
const pin = (key: string, document: unknown, revision = "1") => {
  const bytes = Buffer.from(JSON.stringify(document));
  return { ref: { registry_key: key, revision, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes };
};
(support.supported ? describe : describe.skip)("Frozen Schema sets with actual temporary PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { fixture = await startEmbeddedPostgresTestDatabase("paperclip-onisall-schemas-"); db = createDb(fixture.connectionString); }, 30_000);
  afterEach(async () => {
    // Dedicated temporary test DB only. No development records deleted.
    await db.delete(members); await db.delete(sets); await db.delete(versions);
    await db.delete(activityLog); await db.delete(companyMemberships); await db.delete(companies);
  });
  afterAll(async () => { await fixture?.cleanup(); });
  async function setup() {
    const [company] = await db.insert(companies).values({ name: "Schema fixture", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const assets = [pin("z/report", { type: "object", properties: { title: { type: "string" } }, additionalProperties: false }),
      pin("a/report", { type: "integer", minimum: 1 })];
    const registry = createOfflineSchemaRegistry(assets);
    const refs = assets.map(a => a.ref);
    const service = onisallFrozenSchemaSetService(db, owner);
    return { company: company!, assets, registry, refs, service };
  }
  async function freeze() {
    const f = await setup();
    const result = await f.service.freeze(f.company.id, f.registry, f.refs);
    return { ...f, result };
  }
  it("persists exact original Schema bytes and the existing manifest protocol, then loads an independent registry", async () => {
    const f = await freeze();
    const expected = freezeSchemaValidators(f.registry, f.refs);
    expect(f.result.replayed).toBe(false); expect(f.result.set.manifestSha256).toBe(expected.manifestSha256);
    const [row] = await db.select().from(sets);
    expect(row!.manifest).toBe(JSON.stringify(expected.manifest));
    for (const asset of f.assets) {
      const [stored] = await db.select().from(versions).where(eq(versions.registryKey, asset.ref.registry_key));
      expect(Buffer.from(stored!.content)).toEqual(asset.bytes);
      expect(stored!.sha256).toBe(asset.ref.sha256);
    }
    const before = await Promise.all([sets, members, versions, activityLog].map(table => db.select().from(table)));
    const status = await f.service.get(f.company.id, f.result.set.id);
    expect(status).toMatchObject({ diagnosticsOnly: true, integrity: "verified", currentCompiler: { matchesFrozenProfile: true },
      publication: { status: "unavailable", executionAdmission: "not_granted" } });
    for (const key of ["content", "manifest", "createdByUserId", "validator", "options"]) expect(JSON.stringify(status)).not.toContain(`"${key}"`);
    expect(await Promise.all([sets, members, versions, activityLog].map(table => db.select().from(table)))).toEqual(before);
    const loaded = await db.transaction(tx => readFrozenSchemaSetInTransaction(tx, f.company.id, f.result.set.id), { isolationLevel: "repeatable read", accessMode: "read only" });
    const compiled = freezeSchemaValidators(loaded.registry, loaded.refs);
    expect(compiled.manifestSha256).toBe(expected.manifestSha256);
    const ref = loaded.refs.find(r => r.registry_key === "a/report")!;
    expect(compiled.validate(ref, Buffer.from("2"))).toMatchObject({ valid: true });
    expect(compiled.validate(ref, Buffer.from("0"))).toMatchObject({ valid: false });
    loaded.registry.resolve(ref).bytes.fill(0);
    expect(loaded.registry.resolve(ref).bytes.toString()).toContain('"integer"');
  });
  it("handles four concurrent unordered selections as one set with one audit", async () => {
    const f = await setup();
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => f.service.freeze(f.company.id, f.registry, i % 2 ? [...f.refs].reverse() : f.refs)));
    expect(new Set(results.map(r => r.set.id)).size).toBe(1); expect(results.filter(r => !r.replayed)).toHaveLength(1);
    expect(await db.select().from(sets)).toHaveLength(1); expect(await db.select().from(versions)).toHaveLength(2);
    expect(await db.select().from(activityLog)).toHaveLength(1);
  });
  it("reuses versions across sets and keeps new revisions separate", async () => {
    const f = await freeze();
    const subset = await f.service.freeze(f.company.id, f.registry, [f.refs[0]!]);
    expect(subset.set.id).not.toBe(f.result.set.id); expect(await db.select().from(versions)).toHaveLength(2);
    const next = pin("a/report", { type: "integer", minimum: 2 }, "2");
    await f.service.freeze(f.company.id, createOfflineSchemaRegistry([next]), [next.ref]);
    expect(await db.select().from(versions)).toHaveLength(3);
    expect((await f.service.get(f.company.id, f.result.set.id)).set).toEqual(f.result.set);
  });
  it("rejects a replaced revision and rolls back other newly inserted documents", async () => {
    const f = await freeze();
    const changed = [pin("0/new", { type: "null" }), pin("a/report", { type: "string" })];
    await expect(f.service.freeze(f.company.id, createOfflineSchemaRegistry(changed), changed.map(a => a.ref))).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(versions)).toHaveLength(2); expect(await db.select().from(sets)).toHaveLength(1);
    expect(await db.select().from(activityLog)).toHaveLength(1);
  });
  it.each(["unknown", "duplicate", "bad_schema", "too_many", "aggregate"])("refuses %s selections without records", async failure => {
    const f = await setup();
    let registry = f.registry, refs = f.refs;
    if (failure === "unknown") refs = [{ ...f.refs[0]!, revision: "unknown" }];
    if (failure === "duplicate") refs = [f.refs[0]!, f.refs[0]!];
    if (failure === "bad_schema") { const a = pin("bad", { type: "unrecognized-type" }); registry = createOfflineSchemaRegistry([a]); refs = [a.ref]; }
    if (failure === "too_many") refs = Array(65).fill(f.refs[0]!);
    if (failure === "aggregate") {
      const assets = Array.from({ length: 9 }, (_, i) => pin(`large-${i}`, { type: "object", description: "x".repeat(940_000) }));
      registry = createOfflineSchemaRegistry(assets); refs = assets.map(a => a.ref);
    }
    await expect(f.service.freeze(f.company.id, registry, refs)).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(versions)).toHaveLength(0); expect(await db.select().from(sets)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });
  it.each(["content", "digest", "manifest", "missing_member", "count", "order"])("detects stored %s damage instead of returning verified", async damage => {
    const f = await freeze();
    if (damage === "content") await db.update(versions).set({ content: '"' + "x".repeat(f.assets[0]!.bytes.length - 2) + '"' }).where(eq(versions.registryKey, f.refs[0]!.registry_key));
    if (damage === "digest") await db.update(versions).set({ sha256: "0".repeat(64) });
    if (damage === "manifest") await db.update(sets).set({ manifest: "{}" });
    if (damage === "missing_member") await db.delete(members).where(eq(members.position, 1));
    if (damage === "count") await db.update(sets).set({ schemaCount: 1 });
    if (damage === "order") await db.update(members).set({ position: 2 }).where(eq(members.position, 1));
    await expect(f.service.get(f.company.id, f.result.set.id)).rejects.toMatchObject({ status: 409 });
    await expect(f.service.freeze(f.company.id, f.registry, f.refs)).rejects.toMatchObject({ status: 409 });
  });
  it("preserves an older compiler observation and reports current profile drift", async () => {
    const f = await freeze(); const [row] = await db.select().from(sets);
    const manifest = JSON.parse(row!.manifest); manifest.compiler.ajvVersion = "historical-version";
    const text = JSON.stringify(manifest);
    await db.update(sets).set({ manifest: text, manifestSha256: createHash("sha256").update(text).digest("hex") });
    const status = await f.service.get(f.company.id, f.result.set.id);
    expect(status.currentCompiler.matchesFrozenProfile).toBe(false);
    expect(status.set.compiler.ajvVersion).toBe("historical-version");
    expect((await db.select().from(sets))[0]!.manifest).toBe(text);
    // Direct DB fixture emulates a former supported profile; no API can edit it.
  });
  it("uses one read snapshot during concurrent byte damage, then sees it on the next read", async () => {
    const f = await freeze(); let arrived!: () => void; let release!: () => void;
    const ready = new Promise<void>(r => { arrived = r; }); const hold = new Promise<void>(r => { release = r; });
    const inFlight = db.transaction(async tx => {
      await tx.select().from(sets).where(eq(sets.id, f.result.set.id)); arrived(); await hold;
      return readFrozenSchemaSetInTransaction(tx, f.company.id, f.result.set.id);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    await ready;
    try { await db.update(versions).set({ sha256: "0".repeat(64) }); } finally { release(); }
    expect((await inFlight).status.integrity).toBe("verified");
    await expect(f.service.get(f.company.id, f.result.set.id)).rejects.toMatchObject({ status: 409 });
  });
  it("enforces company references, DB shape, direct board access and viewer read-only authority", async () => {
    const f = await freeze(); const other = await setup();
    await expect(f.service.get(other.company.id, f.result.set.id)).rejects.toMatchObject({ status: 404 });
    const [version] = await db.select().from(versions).where(eq(versions.companyId, f.company.id));
    await expect(db.insert(members).values({ companyId: other.company.id, setId: f.result.set.id, schemaId: version!.id, position: 0 })).rejects.toBeDefined();
    await expect(db.update(sets).set({ executionAdmission: "granted" }).where(eq(sets.id, f.result.set.id))).rejects.toBeDefined();
    await expect(db.update(versions).set({ byteSize: 0 })).rejects.toBeDefined();
    const viewer: AuthorizationActor = { type: "board", source: "session", userId: "owner", companyIds: [f.company.id],
      memberships: [{ companyId: f.company.id, status: "active", membershipRole: "viewer" }] };
    await expect(onisallFrozenSchemaSetService(db, viewer).get(f.company.id, f.result.set.id)).rejects.toMatchObject({ status: 403 });
    await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: "owner",
      status: "active", membershipRole: "viewer" });
    expect((await onisallFrozenSchemaSetService(db, viewer).get(f.company.id, f.result.set.id)).integrity).toBe("verified");
    await expect(onisallFrozenSchemaSetService(db, viewer).freeze(f.company.id, f.registry, f.refs)).rejects.toMatchObject({ status: 403 });
    await db.update(companyMemberships).set({ status: "inactive" });
    await expect(onisallFrozenSchemaSetService(db, viewer).get(f.company.id, f.result.set.id)).rejects.toMatchObject({ status: 403 });
    for (const actor of [{ type: "agent", companyId: f.company.id, agentId: randomUUID() }, { ...owner, source: "mcp_oauth" },
      { type: "none" }, { type: "board", source: "session", userId: "other", companyIds: [] }] as AuthorizationActor[]) {
      await expect(onisallFrozenSchemaSetService(db, actor).get(f.company.id, f.result.set.id)).rejects.toMatchObject({ status: 403 });
      await expect(onisallFrozenSchemaSetService(db, actor).freeze(f.company.id, f.registry, f.refs)).rejects.toMatchObject({ status: 403 });
    }
    for (const status of ["paused", "archived"]) {
      await db.update(companies).set({ status }).where(eq(companies.id, f.company.id));
      await expect(f.service.freeze(f.company.id, f.registry, f.refs)).rejects.toMatchObject({ status: 409 });
      expect((await f.service.get(f.company.id, f.result.set.id)).publication.status).toBe("unavailable");
    }
  });
  it("rolls back all versions, members and set when activity persistence fails", async () => {
    const f = await setup();
    const failingDb = new Proxy(db, { get(target, key) {
      if (key === "transaction") return (work: (tx: unknown) => Promise<unknown>) => db.transaction(async tx => work(new Proxy(tx, { get(conn, member) {
        if (member === "insert") return (table: unknown) => {
          if (table === activityLog) throw new Error("injected-schema-audit-failure");
          return conn.insert(table as typeof activityLog);
        };
        const value = Reflect.get(conn, member); return typeof value === "function" ? value.bind(conn) : value;
      } })));
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(onisallFrozenSchemaSetService(failingDb, owner).freeze(f.company.id, f.registry, f.refs)).rejects.toThrow("injected-schema-audit-failure");
    expect(await db.select().from(versions)).toHaveLength(0); expect(await db.select().from(sets)).toHaveLength(0);
    expect(await db.select().from(members)).toHaveLength(0); expect(await db.select().from(activityLog)).toHaveLength(0);
  });
  it("rejects a nontransaction internal reader", async () => {
    const f = await freeze();
    await expect(readFrozenSchemaSetInTransaction(db as unknown as Parameters<typeof readFrozenSchemaSetInTransaction>[0], f.company.id, f.result.set.id)).rejects.toThrow("requires a transaction");
  });
});
