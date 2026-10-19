import { HttpError } from "../errors.js";

// Only the existing native gate refusals, with their actual HTTP statuses.
// Missing dependencies, malformed configuration and execution admission are
// failures, even if they are represented by HttpError.
const EXPECTED_PREPARATION_REFUSALS: ReadonlyMap<string, number> = new Map([
  ["review_required", 403],
  ["lease_held", 409],
  ["version_conflict", 409],
  ["blocked", 409],
  ["expected_children_mismatch", 409],
  ["children_not_terminal", 409],
  ["unresolved_drift", 409],
  ["review_outdated", 409],
  ["transition_not_allowed", 409],
  ["stage_disabled", 422],
  ["pipeline_archived", 422],
  ["autonomy_not_enabled", 422],
]);

export type PipelineAutoAdvanceOutcome<Result> =
  | { kind: "completed"; result: Result }
  | { kind: "refused"; code: string };

/**
 * Trusted same-transaction composition; this function owns no transaction.
 * Preparation may preserve existing lease-expiration facts. A refusal is not
 * a savepoint rollback. Apply errors always escape, including recognized gate
 * codes: callers must roll back the root instead of accepting partial writes.
 */
export async function attemptPipelineAutoAdvance<Prepared, Result>(
  prepare: () => Promise<Prepared>,
  apply: (prepared: Prepared) => Promise<Result>,
): Promise<PipelineAutoAdvanceOutcome<Result>> {
  let prepared: Prepared;
  try {
    prepared = await prepare();
  } catch (error) {
    if (error instanceof HttpError && error.details !== null && typeof error.details === "object" && !Array.isArray(error.details)) {
      const code = (error.details as { code?: unknown }).code;
      const expectedStatus = typeof code === "string" ? EXPECTED_PREPARATION_REFUSALS.get(code) : undefined;
      if (typeof code === "string" && expectedStatus !== undefined && expectedStatus === error.status) {
        return { kind: "refused", code };
      }
    }
    throw error;
  }
  // Keep apply outside the refusal catch. Completion is not an execution grant.
  return { kind: "completed", result: await apply(prepared) };
}
