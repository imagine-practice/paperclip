import { and, asc, eq } from "drizzle-orm";
import { routines, routineTriggers, type Db } from "@paperclipai/db";
import type { RoutineRevisionSnapshotV1 } from "@paperclipai/shared";

type SnapshotReader = Pick<Db | Parameters<Parameters<Db["transaction"]>[0]>[0], "select">;
type RoutineRow = typeof routines.$inferSelect;
type TriggerRow = typeof routineTriggers.$inferSelect;

/** One current projection for native Routine and Pipeline automation writers.
 * Existing stored snapshots keep their original bytes. Origin is recorded for
 * observation; restoring a snapshot does not restore origin ownership. */
export function routineRevisionSnapshotRoutine(routine: RoutineRow): RoutineRevisionSnapshotV1["routine"] {
  return {
    id: routine.id,
    companyId: routine.companyId,
    projectId: routine.projectId,
    goalId: routine.goalId,
    parentIssueId: routine.parentIssueId,
    title: routine.title,
    description: routine.description,
    assigneeAgentId: routine.assigneeAgentId,
    priority: routine.priority as RoutineRevisionSnapshotV1["routine"]["priority"],
    status: routine.status as RoutineRevisionSnapshotV1["routine"]["status"],
    concurrencyPolicy: routine.concurrencyPolicy as RoutineRevisionSnapshotV1["routine"]["concurrencyPolicy"],
    catchUpPolicy: routine.catchUpPolicy as RoutineRevisionSnapshotV1["routine"]["catchUpPolicy"],
    activityGatePolicy: routine.activityGatePolicy as RoutineRevisionSnapshotV1["routine"]["activityGatePolicy"],
    activityGateScope: routine.activityGateScope as RoutineRevisionSnapshotV1["routine"]["activityGateScope"],
    originKind: routine.originKind,
    originId: routine.originId,
    variables: routine.variables ?? [],
    env: routine.env ?? null,
    responsibleUserId: routine.responsibleUserId ?? null,
  };
}

function routineRevisionSnapshotTrigger(trigger: TriggerRow): RoutineRevisionSnapshotV1["triggers"][number] {
  return {
    id: trigger.id,
    setupPending: trigger.setupPending,
    kind: trigger.kind as RoutineRevisionSnapshotV1["triggers"][number]["kind"],
    label: trigger.label,
    enabled: trigger.enabled,
    cronExpression: trigger.cronExpression,
    timezone: trigger.timezone,
    publicId: trigger.publicId,
    signingMode: trigger.signingMode as RoutineRevisionSnapshotV1["triggers"][number]["signingMode"],
    replayWindowSec: trigger.replayWindowSec,
  };
}

/** DB-only read; caller owns the transaction, scope checks and Routine lock.
 * This snapshot is history, not a configuration fence or execution grant. */
export async function buildRoutineRevisionSnapshot(
  executor: SnapshotReader,
  routine: RoutineRow,
): Promise<RoutineRevisionSnapshotV1> {
  const triggers = await executor.select().from(routineTriggers)
    .where(and(eq(routineTriggers.companyId, routine.companyId),
      eq(routineTriggers.routineId, routine.id), eq(routineTriggers.archived, false)))
    .orderBy(asc(routineTriggers.createdAt), asc(routineTriggers.id));
  return { version: 1, routine: routineRevisionSnapshotRoutine(routine),
    triggers: triggers.map(routineRevisionSnapshotTrigger) };
}
