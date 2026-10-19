import { and, asc, desc, eq, is, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { z } from "zod";
import { companies, onisallRuleVersions as versions, onisallFrozenRuleSets as sets,
  onisallFrozenRuleSetMembers as members, type Db } from "@paperclipai/db";
import type { OnisallFrozenRuleSet, OnisallFrozenRuleSetStatus, OnisallRuleSetCatalog, OnisallRuleKind } from "@paperclipai/shared";
import type { StorageService } from "../../storage/types.js";
import { conflict, forbidden, notFound, unprocessable } from "../../errors.js";
import { authorizationService, type AuthorizationActor } from "../authorization.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import { sha256 } from "./input-snapshot.js";
import { readFrozenSchemaSetInTransaction } from "./frozen-schema-sets.js";
import { freezeSchemaValidators } from "./schema-compiler.js";
import { checkDescriptorSchema, createOfflineCheckRegistry, compareUtf8, preparationJson, type CheckDescriptor } from "./check-registry.js";
import { createOfflineCommandRegistry, pinnedAssetRef, type PinnedAsset } from "./command-registry.js";
import { parseStrictJson } from "./strict-json.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Version = typeof versions.$inferSelect;
export const MAX_RULE_SET_BYTES = 256 * 1024 * 1024;
const maxima = { check: 1024 * 1024, command: 64 * 1024, runtime: MAX_RULE_SET_BYTES, policy: 64 * 1024 } as const;
const kindSchema = z.enum(["check", "command", "runtime", "policy"]);
const assetShape = z.strictObject({ kind: kindSchema, ref: pinnedAssetRef, byte_size: z.number().int().min(1).max(MAX_RULE_SET_BYTES),
  check_descriptor: checkDescriptorSchema.nullable() });
const manifestShape = z.strictObject({ protocol: z.literal("onisall.frozen-rule-set.v1"),
  schema_set: z.strictObject({ id: z.string().uuid(), manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  assets: z.array(assetShape).min(4).max(256) });
type RuleAsset = z.infer<typeof assetShape> & { bytes: Buffer };
export interface TrustedRuleSetInput {
  schemaSetId: string;
  checks: Array<{ descriptor: CheckDescriptor; validatorBytes: Uint8Array }>;
  commands: PinnedAsset[]; runtimes: PinnedAsset[]; policies: PinnedAsset[];
}
function identity(asset: Pick<RuleAsset, "kind" | "ref">) {
  return preparationJson([asset.kind, asset.ref.registry_key, asset.ref.revision]);
}
function metadata(asset: RuleAsset): z.infer<typeof assetShape> {
  return { kind: asset.kind, ref: asset.ref, byte_size: asset.byte_size, check_descriptor: asset.check_descriptor };
}
function rebuild(assets: RuleAsset[]) {
  const selected = assets.filter(a => a.kind === "check");
  const checks = createOfflineCheckRegistry(selected.map(a => ({ descriptor: a.check_descriptor!, validatorBytes: a.bytes })));
  const pick = (kind: OnisallRuleKind) => assets.filter(a => a.kind === kind).map(a => ({ ref: a.ref, bytes: a.bytes }));
  const commands = createOfflineCommandRegistry({ checks, commands: pick("command"), runtimes: pick("runtime"), policies: pick("policy") });
  // Only closed dependency sets can be frozen: no orphan checks/runtime/policy.
  const used = new Set<string>();
  for (const asset of assets.filter(a => a.kind === "command")) {
    const descriptor = parseStrictJson(asset.bytes) as { validator: CheckDescriptor["check"] };
    const resolved = commands.resolve({ command_id: "preparation", ref: asset.ref, validator: descriptor.validator });
    used.add(identity({ kind: "check", ref: { registry_key: resolved.check_descriptor.check.check_id,
      revision: resolved.check_descriptor.check.revision, sha256: resolved.check_descriptor.check.validator_sha256 } }));
    used.add(identity({ kind: "runtime", ref: resolved.runtime_ref }));
    used.add(identity({ kind: "policy", ref: resolved.descriptor.sandbox_policy_ref }));
  }
  if (assets.some(a => a.kind !== "command" && !used.has(identity(a)))) throw new Error("Unreferenced rule asset");
  return { checks, commands };
}
function prepare(input: TrustedRuleSetInput) {
  z.string().uuid().parse(input.schemaSetId);
  if (![input.checks, input.commands, input.runtimes, input.policies].every(items => Array.isArray(items) && items.length > 0 && items.length <= 64)) {
    throw new Error("Rule selection exceeds limits");
  }
  const assets: RuleAsset[] = input.checks.map(item => {
    const descriptor = checkDescriptorSchema.parse(structuredClone(item.descriptor));
    descriptor.target_kinds.sort(compareUtf8);
    return { kind: "check", ref: { registry_key: descriptor.check.check_id, revision: descriptor.check.revision,
      sha256: descriptor.check.validator_sha256 }, bytes: Buffer.from(item.validatorBytes),
      byte_size: item.validatorBytes.byteLength, check_descriptor: descriptor };
  });
  for (const [kind, entries] of [["command", input.commands], ["runtime", input.runtimes], ["policy", input.policies]] as const) {
    for (const item of entries) assets.push({ kind, ref: pinnedAssetRef.parse(item.ref), bytes: Buffer.from(item.bytes),
      byte_size: item.bytes.byteLength, check_descriptor: null });
  }
  if (new Set(assets.map(identity)).size !== assets.length || assets.reduce((sum, a) => sum + a.byte_size, 0) > MAX_RULE_SET_BYTES) {
    throw new Error("Duplicate or oversized rule assets");
  }
  for (const asset of assets) {
    assetShape.parse(metadata(asset));
    if (asset.byte_size > maxima[asset.kind] || sha256(asset.bytes) !== asset.ref.sha256) throw new Error("Rule bytes differ");
  }
  assets.sort((a, b) => compareUtf8(identity(a), identity(b)));
  return { assets, ...rebuild(assets) };
}
function objectKey(companyId: string, asset: Pick<RuleAsset, "kind" | "ref">) {
  return `${companyId}/onisall-rules/v1/${asset.kind}/${asset.ref.sha256}`;
}
async function readVerified(storage: StorageService, row: Version) {
  const kind = kindSchema.parse(row.kind);
  if (row.provider !== storage.provider || row.objectKey !== objectKey(row.companyId, { kind,
    ref: { registry_key: row.registryKey, revision: row.revision, sha256: row.sha256 } })) throw conflict("Rule storage metadata differs");
  let bytes: Buffer;
  try {
    const object = await storage.getObject(row.companyId, row.objectKey);
    const chunks: Buffer[] = []; let size = 0;
    try {
      for await (const chunk of object.stream) {
        const part = Buffer.from(chunk); size += part.length;
        if (size > row.byteSize || size > maxima[kind]) throw new Error("Rule object exceeds limit");
        chunks.push(part);
      }
    } finally { object.stream.destroy(); }
    bytes = Buffer.concat(chunks, size);
  } catch { throw conflict("Rule byte storage is unavailable or differs"); }
  if (bytes.length !== row.byteSize || sha256(bytes) !== row.sha256) throw conflict("Stored rule bytes differ");
  return bytes;
}
function setDto(row: typeof sets.$inferSelect, assets: RuleAsset[]): OnisallFrozenRuleSet {
  return { protocol: "onisall.persisted-rule-set.v1", id: row.id, companyId: row.companyId, schemaSetId: row.schemaSetId,
    manifestSha256: row.manifestSha256, assetCount: row.assetCount, totalByteSize: row.totalByteSize,
    assets: assets.map(a => ({ kind: a.kind, registryKey: a.ref.registry_key, revision: a.ref.revision, sha256: a.ref.sha256,
      byteSize: a.byte_size, check: a.check_descriptor ? { targetKinds: a.check_descriptor.target_kinds,
        evidenceMode: a.check_descriptor.evidence_mode } : null })),
    purpose: "preparation", executionAdmission: "not_granted", createdAt: row.createdAt.toISOString() };
}

/** Actual transaction required. Caller owns scope/authorization; byte loading is
 * bounded and does not execute, import or resolve filesystem/network locations. */
export async function readFrozenRuleSetInTransaction(tx: Tx, storage: StorageService, companyId: string, id: string) {
  if (!is(tx, PgTransaction)) throw new Error("Frozen rule read requires a transaction");
  const [row] = await tx.select().from(sets).where(and(eq(sets.companyId, companyId), eq(sets.id, id)));
  if (!row) throw notFound("Frozen rule set not found");
  if (sha256(Buffer.from(row.manifest)) !== row.manifestSha256 || row.purpose !== "preparation" || row.executionAdmission !== "not_granted") {
    throw conflict("Stored rule manifest differs");
  }
  let manifest: z.infer<typeof manifestShape>;
  try { manifest = manifestShape.parse(parseStrictJson(Buffer.from(row.manifest))); }
  catch { throw conflict("Stored rule manifest differs"); }
  const schemas = await readFrozenSchemaSetInTransaction(tx, companyId, row.schemaSetId);
  if (manifest.schema_set.id !== schemas.status.set.id || manifest.schema_set.manifest_sha256 !== schemas.status.set.manifestSha256) {
    throw conflict("Stored rule Schema binding differs");
  }
  const rows = await tx.select({ position: members.position, rule: versions }).from(members)
    .innerJoin(versions, and(eq(versions.id, members.ruleId), eq(versions.companyId, members.companyId)))
    .where(and(eq(members.companyId, companyId), eq(members.setId, id))).orderBy(asc(members.position));
  if (rows.length !== row.assetCount || rows.some((r, i) => r.position !== i) || rows.reduce((sum, r) => sum + r.rule.byteSize, 0) !== row.totalByteSize) {
    throw conflict("Stored rule members differ");
  }
  const assets: RuleAsset[] = [];
  try {
    for (const { rule } of rows) {
      const entry = assetShape.parse({ kind: rule.kind, ref: { registry_key: rule.registryKey, revision: rule.revision, sha256: rule.sha256 },
        byte_size: rule.byteSize, check_descriptor: rule.descriptor === null ? null : parseStrictJson(Buffer.from(rule.descriptor)) });
      if ((entry.kind === "check") !== (entry.check_descriptor !== null)
        || entry.byte_size > maxima[entry.kind]) throw new Error("Stored rule metadata differs");
      assets.push({ ...entry, bytes: await readVerified(storage, rule) });
    }
    if (preparationJson(assets.map(metadata)) !== preparationJson(manifest.assets)
      || new Set(assets.map(identity)).size !== assets.length) throw new Error("Rule manifest members differ");
    // Descriptor identity must refer to this exact validator, not another row.
    for (const a of assets.filter(a => a.kind === "check")) {
      if (a.check_descriptor!.check.check_id !== a.ref.registry_key || a.check_descriptor!.check.revision !== a.ref.revision
        || a.check_descriptor!.check.validator_sha256 !== a.ref.sha256) throw new Error("Check identity differs");
    }
    const registries = rebuild(assets);
    const matches = schemas.status.currentCompiler.matchesFrozenProfile;
    if (matches) freezeSchemaValidators(schemas.registry, schemas.refs);
    const status: OnisallFrozenRuleSetStatus = { protocol: "onisall.rule-set-status.v1", evaluatedAt: new Date().toISOString(), diagnosticsOnly: true,
      integrity: "verified", set: setDto(row, assets), preparation: { registry: "verified", schemaCompilerMatches: matches,
        schemaCompilation: matches ? "verified" : "profile_changed" },
      publication: { status: "unavailable", executionAdmission: "not_granted" },
      qualification: { sandbox: "not_evaluated", businessAcceptance: "not_evaluated" } };
    return { status, schemas: schemas.registry, schemaRefs: schemas.refs, ...registries };
  } catch { throw conflict("Stored rule assets or current preparation differ"); }
}

export function onisallFrozenRuleSetService(db: Db, storage: StorageService, actor: AuthorizationActor) {
  async function authorize(conn: Db | Tx, companyId: string, write: boolean) {
    if (actor.type !== "board" || !actor.userId || actor.source === "mcp_oauth") throw forbidden("Direct board session required");
    const result = await authorizationService(conn as Db).decide({ actor, action: write ? "pipelines:write" : "company_scope:read",
      resource: { type: "company", companyId } });
    if (!result.allowed) throw forbidden("Current company rule access required");
    return actor.userId;
  }
  return {
    // Trusted deployment call only. No HTTP/worker registration path.
    async freeze(companyId: string, input: TrustedRuleSetInput) {
      const result = await db.transaction(async tx => {
        const userId = await authorize(tx, companyId, true);
        const [company] = await tx.select().from(companies).where(eq(companies.id, companyId)).for("share");
        if (!company) throw notFound("Company not found");
        if (company.status !== "active") throw conflict("Company is not active");
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`onisall-rule-freeze:${companyId}`}, 0))`);
        const schemas = await readFrozenSchemaSetInTransaction(tx, companyId, input.schemaSetId);
        if (!schemas.status.currentCompiler.matchesFrozenProfile) throw conflict("Frozen Schema compiler profile changed");
        let prepared: ReturnType<typeof prepare>;
        try { freezeSchemaValidators(schemas.registry, schemas.refs); prepared = prepare(input); }
        catch { throw unprocessable("Trusted rule selection is invalid or exceeds limits"); }
        const manifest = preparationJson({ protocol: "onisall.frozen-rule-set.v1",
          schema_set: { id: schemas.status.set.id, manifest_sha256: schemas.status.set.manifestSha256 }, assets: prepared.assets.map(metadata) });
        if (Buffer.byteLength(manifest) > 262144) throw unprocessable("Rule manifest exceeds limit");
        const stored: Version[] = [];
        for (const asset of prepared.assets) {
          const condition = and(eq(versions.companyId, companyId), eq(versions.kind, asset.kind),
            eq(versions.registryKey, asset.ref.registry_key), eq(versions.revision, asset.ref.revision));
          let [row] = await tx.select().from(versions).where(condition);
          const descriptor = asset.check_descriptor ? preparationJson(asset.check_descriptor) : null;
          if (!row) {
            const key = objectKey(companyId, asset);
            const [referenced] = await tx.select().from(versions).where(and(eq(versions.companyId, companyId), eq(versions.objectKey, key))).limit(1);
            let object: Awaited<ReturnType<StorageService["putFile"]>>;
            if (referenced) {
              // A new revision sharing bytes cannot overwrite/repair an older
              // referenced object. Read it and fail closed if it is damaged.
              if (!(await readVerified(storage, referenced)).equals(asset.bytes)) throw conflict("Referenced rule bytes differ");
              object = { provider: storage.provider, objectKey: key, sha256: asset.ref.sha256,
                byteSize: asset.byte_size, contentType: "application/octet-stream", originalFilename: null };
            } else {
              try { object = await storage.putFile({ companyId, namespace: "onisall-rules", objectKey: key, originalFilename: null,
                contentType: "application/octet-stream", body: asset.bytes }); }
              catch { throw conflict("Rule byte storage write could not be verified"); }
            }
            if (object.provider !== storage.provider || object.objectKey !== key || object.sha256 !== asset.ref.sha256 || object.byteSize !== asset.byte_size) {
              throw conflict("Rule storage receipt differs");
            }
            [row] = await tx.insert(versions).values({ companyId, kind: asset.kind, registryKey: asset.ref.registry_key,
              revision: asset.ref.revision, sha256: asset.ref.sha256, byteSize: asset.byte_size, descriptor,
              provider: object.provider, objectKey: key }).returning();
          }
          if (!row || row.sha256 !== asset.ref.sha256 || row.byteSize !== asset.byte_size || row.descriptor !== descriptor) {
            throw conflict("Rule revision already names different bytes or descriptor");
          }
          if (!(await readVerified(storage, row)).equals(asset.bytes)) throw conflict("Stored rule bytes differ");
          stored.push(row);
        }
        const manifestSha256 = sha256(Buffer.from(manifest));
        const [created] = await tx.insert(sets).values({ companyId, schemaSetId: schemas.status.set.id, manifest, manifestSha256,
          assetCount: stored.length, totalByteSize: stored.reduce((sum, r) => sum + r.byteSize, 0), createdByUserId: userId })
          .onConflictDoNothing({ target: [sets.companyId, sets.manifestSha256] }).returning();
        const row = created ?? (await tx.select().from(sets).where(and(eq(sets.companyId, companyId), eq(sets.manifestSha256, manifestSha256))))[0];
        if (!row || row.manifest !== manifest) throw conflict("Rule manifest already names different bytes");
        if (created) await tx.insert(members).values(stored.map((rule, position) => ({ companyId, setId: row.id, ruleId: rule.id, position })));
        const loaded = await readFrozenRuleSetInTransaction(tx, storage, companyId, row.id);
        const publication = created ? (await persistActivity(tx as unknown as Db, { companyId, actorType: "user", actorId: userId,
          action: "onisall.rule_set.frozen", entityType: "onisall_frozen_rule_set", entityId: row.id,
          details: { manifestSha256, assetCount: row.assetCount, preparationOnly: true } })).publication : null;
        return { set: loaded.status.set, replayed: !created, publication };
      });
      if (result.publication) publishActivity(result.publication);
      return { set: result.set, replayed: result.replayed };
    },
    async get(companyId: string, id: string): Promise<OnisallFrozenRuleSetStatus> {
      return db.transaction(async tx => { await authorize(tx, companyId, false);
        return (await readFrozenRuleSetInTransaction(tx, storage, companyId, id)).status;
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
    async list(companyId: string, offset = 0): Promise<OnisallRuleSetCatalog> {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw unprocessable("Invalid rule catalog offset");
      return db.transaction(async tx => {
        await authorize(tx, companyId, false);
        const [company] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
        if (!company) throw notFound("Company not found");
        const rows = await tx.select().from(sets).where(eq(sets.companyId, companyId)).orderBy(desc(sets.createdAt), desc(sets.id)).limit(51).offset(offset);
        return { protocol: "onisall.rule-set-catalog.v1", companyId, evaluatedAt: new Date().toISOString(),
          sets: rows.slice(0, 50).map(row => ({ id: row.id, schemaSetId: row.schemaSetId, manifestSha256: row.manifestSha256,
            assetCount: row.assetCount, totalByteSize: row.totalByteSize, purpose: "preparation", executionAdmission: "not_granted",
            createdAt: row.createdAt.toISOString() })), nextOffset: rows.length > 50 ? offset + 50 : null };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
  };
}
