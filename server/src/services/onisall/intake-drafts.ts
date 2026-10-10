import { and, asc, eq, sql } from "drizzle-orm";
import { companies, onisallInputSnapshots as snapshots, onisallIntakeDrafts as drafts,
  onisallInputObservations as observations, type Db } from "@paperclipai/db";
import { createOnisallIntakeDraftSchema, observeOnisallInputSchema,
  type CreateOnisallIntakeDraft, type ObserveOnisallInput, type OnisallIntakeDraft,
  type OnisallInputSnapshot, type OnisallInputObservation } from "@paperclipai/shared";
import { readIntakeBinding, bindingView } from "./binding-view.js";
import type { AuthorizationActor } from "../authorization.js";
import type { StorageService } from "../../storage/types.js";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import { captureInputText, InputSnapshotError, MAX_INPUT_BYTES, sha256 } from "./input-snapshot.js";

type Snapshot = typeof snapshots.$inferSelect;
type Draft = typeof drafts.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const scope = (companyId: string, id: string) => and(eq(drafts.companyId, companyId), eq(drafts.id, id));
function snapshotView(row: Snapshot): OnisallInputSnapshot {
  return { id: row.id, companyId: row.companyId, protocol: "onisall.input-text.v1", sha256: row.sha256,
    byteSize: row.byteSize, lineCount: row.lineCount, hasBom: row.hasBom, createdAt: row.createdAt.toISOString() };
}
async function draftView(conn: Db | Tx, row: Draft, snapshot: Snapshot, actor?: AuthorizationActor): Promise<OnisallIntakeDraft> {
  const binding = await readIntakeBinding(conn, row.companyId, row.id, actor);
  if (row.bindingStatus !== (binding ? "bound" : "binding_pending")) throw conflict("Intake binding projection differs");
  return { kind: "intake_draft", draftVersion: 2, id: row.id, companyId: row.companyId,
    businessKey: row.businessKey, goal: row.goal, sourceLabel: row.sourceLabel,
    status: "draft", bindingStatus: binding ? "bound" : "binding_pending", controlMode: "native_pipeline",
    clientId: null, projectId: binding?.projectId ?? null, caseId: binding?.caseId ?? null,
    binding: binding ? bindingView(binding) : null, contractId: null,
    initialSnapshot: snapshotView(snapshot), createdAt: row.createdAt.toISOString() };
}
function observationView(row: typeof observations.$inferSelect): OnisallInputObservation {
  return { ...row, observedAt: row.observedAt.toISOString() };
}
function decode(content: string) {
  const bytes = Buffer.from(content, "base64");
  if (bytes.toString("base64") !== content) throw unprocessable("Non-canonical base64 input");
  try {
    const captured = captureInputText(bytes);
    if (captured.lineCount > 10000) throw unprocessable("Draft input exceeds 10000 lines");
    return { bytes, captured };
  } catch (error) {
    if (error instanceof InputSnapshotError) throw unprocessable("Invalid input snapshot", { code: error.code });
    throw error;
  }
}

// Routes authenticate board/company membership. No Agent grants or native work
// are created here. All database writes, including audit, share one transaction.
export function onisallIntakeDraftService(db: Db, storage: StorageService, actor?: AuthorizationActor) {
  async function activeCompany(conn: Db | Tx, companyId: string, lock = false) {
    const query = conn.select().from(companies).where(eq(companies.id, companyId));
    const [company] = await (lock ? query.for("share") : query);
    if (!company) throw notFound("Company not found");
    if (company.status !== "active") throw conflict("Company is not active");
  }
  async function findDraft(conn: Db | Tx, companyId: string, id: string, lock = false) {
    const query = conn.select().from(drafts).where(scope(companyId, id));
    const [row] = await (lock ? query.for("share") : query);
    if (!row) throw notFound("Intake draft not found");
    await readIntakeBinding(conn, companyId, id, actor);
    return row;
  }
  async function findSnapshot(conn: Db | Tx, companyId: string, id: string) {
    const [row] = await conn.select().from(snapshots).where(and(eq(snapshots.companyId, companyId), eq(snapshots.id, id)));
    if (!row) throw notFound("Input snapshot not found");
    return row;
  }
  async function readVerified(row: Pick<Snapshot, "companyId" | "provider" | "objectKey" | "sha256" | "byteSize">) {
    if (storage.provider !== row.provider) throw conflict("Input storage provider unavailable");
    const object = await storage.getObject(row.companyId, row.objectKey);
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of object.stream) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_INPUT_BYTES || size > row.byteSize) throw conflict("Stored input size differs");
        chunks.push(bytes);
      }
    } finally { object.stream.destroy(); }
    const bytes = Buffer.concat(chunks);
    if (size !== row.byteSize || sha256(bytes) !== row.sha256) throw conflict("Stored input integrity differs");
    return bytes;
  }
  async function audit(tx: Tx, companyId: string, actorId: string, action: string, entityId: string, snapshotId: string) {
    return (await persistActivity(tx as unknown as Db, { companyId, actorType: "user", actorId,
      action, entityType: "onisall_intake_draft", entityId, details: { snapshotId, draftOnly: true } })).publication;
  }
  return {
    async create(companyId: string, actorId: string, input: CreateOnisallIntakeDraft) {
      const data = createOnisallIntakeDraftSchema.parse(input);
      await activeCompany(db, companyId);
      const { bytes, captured } = decode(data.contentBase64);
      const businessKey = `manual-input.v1:${sha256(Buffer.from(data.requestKey, "utf8"))}`;
      // Explicit fixed tuple, not the published-contract canonical hash protocol.
      const requestHash = sha256(Buffer.from(JSON.stringify([1, data.goal, data.sourceLabel, captured.sha256])));
      const [existing] = await db.select().from(drafts).where(and(eq(drafts.companyId, companyId), eq(drafts.businessKey, businessKey)));
      if (existing) {
        if (existing.requestHash !== requestHash) throw conflict("Request key already names different input");
        const snapshot = await findSnapshot(db, companyId, existing.initialSnapshotId);
        await readVerified(snapshot);
        const view = await db.transaction(async tx => {
          await activeCompany(tx, companyId, true);
          const current = await findDraft(tx, companyId, existing.id, true);
          return draftView(tx, current, snapshot, actor);
        });
        return { draft: view, replayed: true };
      }
      const result = await db.transaction(async (tx) => {
        await activeCompany(tx, companyId, true);
        // Serialize content-addressed writes across API processes. Windows cannot
        // reliably replace a file while another writer/readback has it open.
        // The file operation is still outside DB atomicity: rollback may leave
        // an orphan, which must be retained for reconciliation rather than deleted.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`onisall-input:${companyId}:${captured.sha256}`}, 0))`);
        const [known] = await tx.select().from(snapshots).where(and(eq(snapshots.companyId, companyId), eq(snapshots.sha256, captured.sha256)));
        const stored = known ?? await storage.putFile({ companyId, namespace: "onisall-inputs",
          objectKey: `${companyId}/onisall-inputs/v1/${captured.sha256}.txt`,
          originalFilename: "input.txt", contentType: "text/plain; charset=utf-8", body: bytes });
        if (stored.sha256 !== captured.sha256 || stored.byteSize !== captured.byteSize) throw conflict("Input storage receipt differs");
        await readVerified({ ...stored, companyId });
        await tx.insert(snapshots).values({ companyId, protocol: captured.protocol, sha256: captured.sha256,
          byteSize: captured.byteSize, lineCount: captured.lineCount, hasBom: captured.hasBom,
          provider: stored.provider, objectKey: stored.objectKey }).onConflictDoNothing({ target: [snapshots.companyId, snapshots.sha256] });
        const [snapshot] = await tx.select().from(snapshots).where(and(eq(snapshots.companyId, companyId), eq(snapshots.sha256, captured.sha256)));
        if (!snapshot || snapshot.objectKey !== stored.objectKey || snapshot.provider !== stored.provider || snapshot.byteSize !== captured.byteSize) {
          throw conflict("Concurrent input storage binding differs");
        }
        const [created] = await tx.insert(drafts).values({ companyId, businessKey, requestHash,
          goal: data.goal, sourceLabel: data.sourceLabel, initialSnapshotId: snapshot.id, createdByUserId: actorId })
          .onConflictDoNothing({ target: [drafts.companyId, drafts.businessKey] }).returning();
        const row = created ?? (await tx.select().from(drafts).where(and(eq(drafts.companyId, companyId), eq(drafts.businessKey, businessKey))))[0];
        if (!row || row.requestHash !== requestHash) throw conflict("Request key already names different input");
        if (!created) return { draft: await draftView(tx, await findDraft(tx, companyId, row.id, true), snapshot, actor), replayed: true, publication: null };
        await tx.insert(observations).values({ companyId, intakeId: row.id, snapshotId: snapshot.id,
          requestKey: data.requestKey, observedByUserId: actorId });
        return { draft: await draftView(tx, row, snapshot, actor), replayed: false,
          publication: await audit(tx, companyId, actorId, "onisall.intake_draft.created", row.id, snapshot.id) };
      });
      if (result.publication) publishActivity(result.publication);
      return { draft: result.draft, replayed: result.replayed };
    },
    async get(companyId: string, id: string) {
      return db.transaction(async tx => {
        const row = await findDraft(tx, companyId, id, true);
        return draftView(tx, row, await findSnapshot(tx, companyId, row.initialSnapshotId), actor);
      });
    },
    async content(companyId: string, id: string) {
      const row = await findDraft(db, companyId, id);
      const snapshot = await findSnapshot(db, companyId, row.initialSnapshotId);
      return { bytes: await readVerified(snapshot), sha256: snapshot.sha256 };
    },
    async observe(companyId: string, id: string, actorId: string, input: ObserveOnisallInput) {
      const data = observeOnisallInputSchema.parse(input);
      const { captured } = decode(data.contentBase64);
      const row = await findDraft(db, companyId, id);
      const snapshot = await findSnapshot(db, companyId, row.initialSnapshotId);
      if (snapshot.sha256 !== captured.sha256) throw conflict("Changed input requires an explicit draft revision");
      await readVerified(snapshot);
      const result = await db.transaction(async (tx) => {
        await activeCompany(tx, companyId, true);
        const current = await findDraft(tx, companyId, id);
        if (current.initialSnapshotId !== snapshot.id) throw conflict("Draft input changed");
        const [created] = await tx.insert(observations).values({ companyId, intakeId: id,
          snapshotId: snapshot.id, requestKey: data.requestKey, observedByUserId: actorId })
          .onConflictDoNothing({ target: [observations.companyId, observations.intakeId, observations.requestKey] }).returning();
        const observation = created ?? (await tx.select().from(observations).where(and(eq(observations.companyId, companyId),
          eq(observations.intakeId, id), eq(observations.requestKey, data.requestKey))))[0];
        if (!observation || observation.snapshotId !== snapshot.id) throw conflict("Observation request differs");
        return { observation: observationView(observation), replayed: !created,
          publication: created ? await audit(tx, companyId, actorId, "onisall.input.observed", id, snapshot.id) : null };
      });
      if (result.publication) publishActivity(result.publication);
      return { observation: result.observation, replayed: result.replayed };
    },
    async observations(companyId: string, id: string, offset: number) {
      await findDraft(db, companyId, id);
      const rows = await db.select().from(observations).where(and(eq(observations.companyId, companyId), eq(observations.intakeId, id)))
        .orderBy(asc(observations.observedAt), asc(observations.id)).offset(offset).limit(101);
      return { observations: rows.slice(0, 100).map(observationView), nextOffset: rows.length > 100 ? offset + 100 : null };
    },
  };
}
