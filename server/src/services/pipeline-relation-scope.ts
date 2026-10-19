import { conflict } from "../errors.js";

/** PostgreSQL UUID identity is case insensitive; URL spelling is not a new ID. */
export function samePipelineUuid(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

/** No related IDs, counts or foreign row contents belong in these errors. */
export function pipelineRelationScopeError() {
  return conflict("Pipeline relation is unavailable in this company", { code: "pipeline_relation_scope" });
}

export function pipelineRelationChangedError() {
  return conflict("Pipeline relation changed during mutation", { code: "pipeline_relation_changed" });
}

/** New relation locks never introduce a blocking row-lock wait or retry.
 * SQL lock failures abort the transaction; callers must let the root roll back. */
export async function withPipelineRelationLock<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    let cause: unknown = error;
    const seen = new Set<unknown>();
    while (cause && typeof cause === "object" && !seen.has(cause)) {
      seen.add(cause);
      if ((cause as { code?: unknown }).code === "55P03") {
        throw conflict("Pipeline relation is busy", { code: "pipeline_relation_busy" });
      }
      cause = (cause as { cause?: unknown }).cause;
    }
    throw error;
  }
}
