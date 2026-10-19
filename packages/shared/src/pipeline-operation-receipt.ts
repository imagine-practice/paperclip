import { z } from "zod";

const uuid = z.string().guid().transform(value => value.toLowerCase());
const version = z.string().regex(/^[1-9][0-9]*$/);
export const PIPELINE_OPERATION_RECEIPT_LIMITS = Object.freeze({ knownExecutions: 64, canonicalBytes: 256 * 1024 });

/** Explicit protocol, separate from the unchanged legacy transition request. */
export const pipelineOperationTransitionRequestSchema = z.object({
  operationId: uuid,
  toStageKey: z.string().trim().min(1).max(120),
  expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  leaseToken: uuid.nullable().optional(),
  reason: z.string().max(4_000).nullable().optional(),
  force: z.boolean().optional(),
  acceptSuggestionId: uuid.optional(),
}).strict();
export type PipelineOperationTransitionRequest = z.infer<typeof pipelineOperationTransitionRequestSchema>;

const eventReference = z.object({ companyId: uuid, caseId: uuid, eventId: uuid }).strict();
const executionReference = eventReference.extend({ executionId: uuid }).strict();
export const pipelineOperationFactsSchema = z.object({
  companyId: uuid,
  caseId: uuid,
  expectedVersion: version,
  returnedCase: z.object({ id: uuid, version }).strict(),
  primaryEvent: eventReference,
  primaryExecutionId: uuid.nullable(),
  knownExecutions: z.array(executionReference).max(PIPELINE_OPERATION_RECEIPT_LIMITS.knownExecutions),
  rootFinalCase: z.object({ id: uuid, version, stageId: uuid }).strict(),
  complete: z.literal(false),
  uncovered: z.tuple([
    z.literal("recursive_case_mutations"), z.literal("other_events"), z.literal("parent_counters"),
    z.literal("blockers"), z.literal("comments"), z.literal("postcommit_dispatch"), z.literal("external_effects"),
  ]),
}).strict();
export type PipelineOperationFacts = z.infer<typeof pipelineOperationFactsSchema>;

export interface PipelineOperationReceipt {
  operationId: string;
  rootEvidence: "exact_receipt_observed";
  coverageKind: "limited_root_result_v1";
  complete: false;
  facts: PipelineOperationFacts;
  recordedAt: string;
  replayed: boolean;
  executionEligibility: "not_assessed";
}

/** v1 logical JSON encoding. Call only with values validated by this protocol. */
export function canonicalPipelineOperationJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPipelineOperationJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalPipelineOperationJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("Unsupported pipeline operation canonical value");
}
