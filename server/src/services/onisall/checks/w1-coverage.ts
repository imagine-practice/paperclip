import { z } from "zod";

const text = z.string().min(1).max(2000);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const line = z.number().int().min(1).max(10_000);
export const w1CoverageSchema = z.object({
  kind: z.literal("w1_coverage_index"), schema_version: z.literal(1), source_sha256: digest,
  groups: z.array(z.object({
    requirement_id: z.string().regex(/^W1-R(?:0[1-9]|1[0-2])$/),
    disposition: z.enum(["specified", "blocked"]),
    unresolved_ids: z.array(z.string().regex(/^W1-D0[1-8]$/)).max(8),
    criteria: z.array(z.object({
      criterion_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/),
      statement: text, verification_method: text,
      basis: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("source"), first_line: line, last_line: line, quote_sha256: digest }).strict(),
        z.object({ kind: z.literal("inference"), rationale: text }).strict(),
      ]),
    }).strict()).min(1).max(100),
  }).strict()).min(1).max(12),
}).strict();
export type W1CoverageIndex = z.infer<typeof w1CoverageSchema>;

// This is the one structural definition. The deployment build serializes its
// JSON Schema export and pins those actual bytes in the schema registry.
export function w1CoverageJsonSchema() {
  return { ...z.toJSONSchema(w1CoverageSchema, { target: "draft-2020-12" }),
    $id: "urn:onisall:w1:coverage-index:1" };
}

export interface TraceabilityProfile {
  readonly source_sha256: string;
  readonly line_count: number;
  readonly groups: readonly { readonly requirement_id: string; readonly ranges: readonly (readonly [number, number])[] }[];
}

// Deployment profile derived from the W1 preparation index, bound to the exact
// original input. Updating the input requires a new profile/checker revision.
export const W1_TRACEABILITY_PROFILE: TraceabilityProfile = Object.freeze({
  source_sha256: "9f93fdbde378abfa80bb64b9fef73bd77b5bff7bbfc0d77a06744baed4e99c26",
  line_count: 105,
  groups: Object.freeze([
    ["W1-R01", [[29, 29]]], ["W1-R02", [[42, 46]]], ["W1-R03", [[47, 54]]],
    ["W1-R04", [[55, 61], [90, 96]]], ["W1-R05", [[62, 67], [98, 104]]],
    ["W1-R06", [[68, 73], [102, 103]]], ["W1-R07", [[74, 75]]], ["W1-R08", [[76, 80]]],
    ["W1-R09", [[81, 81], [88, 88]]], ["W1-R10", [[83, 89]]], ["W1-R11", [[9, 20]]],
    ["W1-R12", [[94, 94], [104, 104]]],
  ].map(([requirement_id, ranges]) => Object.freeze({ requirement_id: requirement_id as string,
    ranges: Object.freeze((ranges as number[][]).map(range => Object.freeze(range as [number, number]))) }))),
});
