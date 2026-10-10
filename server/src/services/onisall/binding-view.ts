import { and, eq } from "drizzle-orm";
import { onisallNativeBindings, projects, type Db } from "@paperclipai/db";
import type { OnisallNativeBinding } from "@paperclipai/shared";
import { notFound } from "../../errors.js";
import { canActorReadProjectPrivacy, type AuthorizationActor } from "../authorization.js";

type Conn = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
export function bindingView(row: typeof onisallNativeBindings.$inferSelect): OnisallNativeBinding {
  return { id: row.id, companyId: row.companyId, intakeId: row.intakeId, snapshotId: row.snapshotId,
    inputSha256: row.inputSha256, pipelineId: row.pipelineId, projectId: row.projectId, caseId: row.caseId,
    entryStageKey: row.entryStageKey, configurationHash: row.configurationHash, revision: 1,
    purpose: "preparation", executionAdmission: "not_granted", createdAt: row.createdAt.toISOString() };
}
export async function assertBindingProjectVisible(conn: Conn, companyId: string, projectId: string | null,
  actor?: AuthorizationActor) {
  if (!projectId) return;
  const [project] = await conn.select().from(projects).where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)));
  if (!project || !actor || !(await canActorReadProjectPrivacy(conn, actor, project))) throw notFound("Project not found");
}
export async function readIntakeBinding(conn: Conn, companyId: string, intakeId: string, actor?: AuthorizationActor) {
  const [row] = await conn.select().from(onisallNativeBindings)
    .where(and(eq(onisallNativeBindings.companyId, companyId), eq(onisallNativeBindings.intakeId, intakeId)));
  if (row) await assertBindingProjectVisible(conn, companyId, row.projectId, actor);
  return row ?? null;
}
