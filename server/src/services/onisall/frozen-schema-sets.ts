import { and, asc, eq, is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { z } from "zod";
import { companies, onisallSchemaVersions as versions, onisallFrozenSchemaSets as sets,
  onisallFrozenSchemaSetMembers as members, type Db } from "@paperclipai/db";
import type { OnisallFrozenSchemaSetStatus } from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../../errors.js";
import { authorizationService, type AuthorizationActor } from "../authorization.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import { createOfflineSchemaRegistry, SchemaRegistryError, type PinnedSchemaRef } from "./schema-registry.js";
import { freezeSchemaValidators, SCHEMA_COMPILER_PROFILE, SchemaCompilationError } from "./schema-compiler.js";
import { sha256 } from "./input-snapshot.js";
import { bindingDigest } from "./binding-configuration.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Registry = ReturnType<typeof createOfflineSchemaRegistry>;
export const MAX_PERSISTED_SCHEMA_BYTES = 8 * 1024 * 1024;
const reference = z.object({ registry_key: z.string().min(1).max(200), revision: z.string().min(1).max(160),
  sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const manifestShape = z.object({ protocol: z.literal("onisall.frozen-schema-set.v1"),
  compiler: z.object({ protocol: z.literal("onisall.schema-compiler.v1"), ajvVersion: z.string().min(1).max(160),
    formatsVersion: z.string().min(1).max(160) }).passthrough(), schemas: z.array(reference).min(1).max(64) }).strict();

/** Caller owns authorization and snapshot/locks. No compile, loader, dispatch
 * or HTTP input here. Returned registry contains fresh copies of verified bytes. */
export async function readFrozenSchemaSetInTransaction(tx: Tx, companyId: string, id: string) {
  if (!is(tx, PgTransaction)) throw new Error("Frozen Schema read requires a transaction");
  const [row] = await tx.select().from(sets).where(and(eq(sets.companyId, companyId), eq(sets.id, id)));
  if (!row) throw notFound("Frozen Schema set not found");
  if (sha256(Buffer.from(row.manifest, "utf8")) !== row.manifestSha256
    || row.purpose !== "preparation" || row.executionAdmission !== "not_granted") throw conflict("Stored Schema set differs");
  let manifest: z.infer<typeof manifestShape>;
  try { manifest = manifestShape.parse(JSON.parse(row.manifest)); }
  catch { throw conflict("Stored Schema manifest differs"); }
  const rows = await tx.select({ position: members.position, schema: versions }).from(members)
    .innerJoin(versions, and(eq(versions.id, members.schemaId), eq(versions.companyId, members.companyId)))
    .where(and(eq(members.companyId, companyId), eq(members.setId, id))).orderBy(asc(members.position));
  const refs: PinnedSchemaRef[] = rows.map(({ schema }) => ({ registry_key: schema.registryKey, revision: schema.revision, sha256: schema.sha256 }));
  if (rows.length !== row.schemaCount || rows.some((entry, i) => entry.position !== i)
    || JSON.stringify(refs) !== JSON.stringify(manifest.schemas)
    || rows.reduce((sum, entry) => sum + entry.schema.byteSize, 0) !== row.totalByteSize) throw conflict("Stored Schema members differ");
  const entries = rows.map(({ schema }) => {
    const bytes = Buffer.from(schema.content, "utf8");
    if (bytes.length !== schema.byteSize || sha256(bytes) !== schema.sha256) throw conflict("Stored Schema bytes differ");
    return { ref: { registry_key: schema.registryKey, revision: schema.revision, sha256: schema.sha256 }, bytes };
  });
  let registry: Registry;
  try { registry = createOfflineSchemaRegistry(entries); }
  catch { throw conflict("Stored Schema document differs"); }
  const frozenProfileHash = bindingDigest(manifest.compiler);
  const currentProfileHash = bindingDigest(SCHEMA_COMPILER_PROFILE);
  const status: OnisallFrozenSchemaSetStatus = { protocol: "onisall.schema-set-status.v1", evaluatedAt: new Date().toISOString(),
    diagnosticsOnly: true, integrity: "verified", set: { protocol: "onisall.persisted-schema-set.v1", id, companyId,
      manifestSha256: row.manifestSha256, schemaCount: row.schemaCount, totalByteSize: row.totalByteSize,
      schemas: rows.map(({ schema }) => ({ registryKey: schema.registryKey, revision: schema.revision, sha256: schema.sha256, byteSize: schema.byteSize })),
      compiler: { protocol: "onisall.schema-compiler.v1", ajvVersion: manifest.compiler.ajvVersion,
        formatsVersion: manifest.compiler.formatsVersion, profileSha256: frozenProfileHash },
      purpose: "preparation", executionAdmission: "not_granted", createdAt: row.createdAt.toISOString() },
    currentCompiler: { profileSha256: currentProfileHash, matchesFrozenProfile: frozenProfileHash === currentProfileHash },
    publication: { status: "unavailable", executionAdmission: "not_granted" } };
  return { status, registry, refs };
}

export function onisallFrozenSchemaSetService(db: Db, actor: AuthorizationActor) {
  async function authorize(conn: Db | Tx, companyId: string, write: boolean) {
    if (actor.type !== "board" || !actor.userId || actor.source === "mcp_oauth") throw forbidden("Direct board session required");
    const result = await authorizationService(conn as Db).decide({ actor,
      action: write ? "pipelines:write" : "company_scope:read", resource: { type: "company", companyId } });
    if (!result.allowed) throw forbidden("Company rule access required");
    return actor.userId;
  }
  return {
    // Internal trusted deployment call only. No HTTP Schema registration.
    async freeze(companyId: string, registry: Registry, refs: readonly PinnedSchemaRef[]) {
      const result = await db.transaction(async tx => {
        const userId = await authorize(tx, companyId, true);
        const [company] = await tx.select().from(companies).where(eq(companies.id, companyId)).for("share");
        if (!company) throw notFound("Company not found");
        if (company.status !== "active") throw conflict("Company is not active");
        let compiled: ReturnType<typeof freezeSchemaValidators>;
        try { compiled = freezeSchemaValidators(registry, refs); }
        catch (error) {
          if (error instanceof SchemaRegistryError || error instanceof SchemaCompilationError) throw unprocessable("Trusted Schema selection is unavailable");
          throw error;
        }
        const selected = compiled.manifest.schemas.map(ref => registry.resolve(ref));
        const totalByteSize = selected.reduce((sum, entry) => sum + entry.bytes.length, 0);
        if (totalByteSize > MAX_PERSISTED_SCHEMA_BYTES) throw unprocessable("Schema set exceeds persistence limit");
        const manifest = JSON.stringify(compiled.manifest);
        const storedVersions: Array<typeof versions.$inferSelect> = [];
        // Stable tuple order also keeps multi-set concurrent inserts from
        // taking the same immutable version locks in opposite order.
        for (const { ref, bytes } of selected) {
          const content = bytes.toString("utf8");
          if (!Buffer.from(content, "utf8").equals(bytes)) throw unprocessable("Trusted Schema encoding differs");
          await tx.insert(versions).values({ companyId, registryKey: ref.registry_key, revision: ref.revision,
            sha256: ref.sha256, byteSize: bytes.length, content }).onConflictDoNothing({ target: [versions.companyId, versions.registryKey, versions.revision] });
          const [row] = await tx.select().from(versions).where(and(eq(versions.companyId, companyId),
            eq(versions.registryKey, ref.registry_key), eq(versions.revision, ref.revision)));
          if (!row || row.sha256 !== ref.sha256 || row.byteSize !== bytes.length || row.content !== content) throw conflict("Schema revision already names different bytes");
          storedVersions.push(row);
        }
        const [created] = await tx.insert(sets).values({ companyId, manifest, manifestSha256: compiled.manifestSha256,
          schemaCount: selected.length, totalByteSize, createdByUserId: userId })
          .onConflictDoNothing({ target: [sets.companyId, sets.manifestSha256] }).returning();
        const row = created ?? (await tx.select().from(sets).where(and(eq(sets.companyId, companyId), eq(sets.manifestSha256, compiled.manifestSha256))))[0];
        if (!row || row.manifest !== manifest) throw conflict("Schema manifest already names different bytes");
        if (created) await tx.insert(members).values(storedVersions.map((version, position) => ({ companyId, setId: row.id, schemaId: version.id, position })));
        const loaded = await readFrozenSchemaSetInTransaction(tx, companyId, row.id);
        if (loaded.status.set.manifestSha256 !== compiled.manifestSha256 || loaded.status.set.totalByteSize !== totalByteSize) throw conflict("Stored Schema set differs");
        const publication = created ? (await persistActivity(tx as unknown as Db, { companyId, actorType: "user", actorId: userId,
          action: "onisall.schema_set.frozen", entityType: "onisall_frozen_schema_set", entityId: row.id,
          details: { manifestSha256: row.manifestSha256, schemaCount: row.schemaCount, preparationOnly: true } })).publication : null;
        return { set: loaded.status.set, replayed: !created, publication };
      });
      if (result.publication) publishActivity(result.publication);
      return { set: result.set, replayed: result.replayed };
    },
    async get(companyId: string, id: string): Promise<OnisallFrozenSchemaSetStatus> {
      return db.transaction(async tx => {
        await authorize(tx, companyId, false);
        return (await readFrozenSchemaSetInTransaction(tx, companyId, id)).status;
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
  };
}
