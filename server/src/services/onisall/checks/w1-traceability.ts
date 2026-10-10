import { captureInputText, MAX_INPUT_BYTES, sha256 } from "../input-snapshot.js";
import { parseStrictJson, STRICT_JSON_LIMITS } from "../strict-json.js";
import { w1CoverageSchema, type TraceabilityProfile } from "./w1-coverage.js";

export type TraceabilityReason = "traceability_complete" | "invalid_candidate" | "invalid_source" |
  "source_mismatch" | "group_coverage_mismatch" | "duplicate_criterion" | "invalid_disposition" |
  "blank_criterion" | "invalid_locator" | "quote_mismatch" | "source_coverage_missing";

// The profile is trusted deployment configuration, never part of worker input.
// This checks references/coverage, not the truth or completeness of statements.
export function createTraceabilityChecker(profile: TraceabilityProfile) {
  if (!/^[a-f0-9]{64}$/.test(profile.source_sha256) || !Number.isSafeInteger(profile.line_count) ||
      profile.line_count < 1 || profile.line_count > 10_000 || !profile.groups.length || profile.groups.length > 12) {
    throw new Error("invalid_profile");
  }
  const sourceHash = profile.source_sha256, lineCount = profile.line_count;
  const groups = new Map<string, readonly (readonly [number, number])[]>();
  for (const group of profile.groups) {
    if (!/^W1-R(?:0[1-9]|1[0-2])$/.test(group.requirement_id) || groups.has(group.requirement_id) ||
        !group.ranges.length || group.ranges.length > 100) throw new Error("invalid_profile");
    const covered = new Set<number>();
    const ranges = group.ranges.map(([first, last]) => {
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || first > last || last > lineCount) {
        throw new Error("invalid_profile");
      }
      for (let line = first; line <= last; line++) {
        if (covered.has(line)) throw new Error("invalid_profile");
        covered.add(line);
      }
      return [first, last] as const;
    });
    groups.set(group.requirement_id, ranges);
  }
  return Object.freeze({
    check(candidateBytes: Uint8Array, sourceBytes: Uint8Array) {
      let candidateHash: string | null = null;
      let observedSourceHash: string | null = null;
      const counts = { groups: 0, criteria: 0, source_references: 0, inferences: 0, blocked_groups: 0 };
      function result(reason: TraceabilityReason) {
        return Object.freeze({ protocol: "onisall.w1-traceability-result.v1", check_id: "W1-C01-traceability", revision: "1",
          outcome: reason === "traceability_complete" ? "pass" as const : "fail" as const,
          reason, candidate_sha256: candidateHash, source_sha256: observedSourceHash,
          expected_source_sha256: sourceHash, counts: Object.freeze({ ...counts }),
          semantic_review: "required" as const, authority: "traceability_only" as const });
      }
      if (!(candidateBytes instanceof Uint8Array) || candidateBytes.byteLength > STRICT_JSON_LIMITS.bytes) return result("invalid_candidate");
      if (!(sourceBytes instanceof Uint8Array) || !sourceBytes.byteLength || sourceBytes.byteLength > MAX_INPUT_BYTES) return result("invalid_source");
      const candidate = Buffer.from(candidateBytes), source = Buffer.from(sourceBytes);
      candidateHash = sha256(candidate); observedSourceHash = sha256(source);
      if (observedSourceHash !== sourceHash) return result("source_mismatch");
      let snapshot: ReturnType<typeof captureInputText>;
      try { snapshot = captureInputText(source); } catch { return result("invalid_source"); }
      if (snapshot.lineCount !== lineCount) return result("source_mismatch");
      let parsed: ReturnType<typeof w1CoverageSchema.safeParse>;
      try { parsed = w1CoverageSchema.safeParse(parseStrictJson(candidate)); } catch { return result("invalid_candidate"); }
      if (!parsed.success) return result("invalid_candidate");
      const index = parsed.data;
      if (index.source_sha256 !== sourceHash) return result("source_mismatch");
      if (index.groups.length !== groups.size || new Set(index.groups.map(g => g.requirement_id)).size !== groups.size ||
          index.groups.some(g => !groups.has(g.requirement_id))) return result("group_coverage_mismatch");
      const ids = new Set<string>();
      for (const group of index.groups) {
        counts.groups++;
        if (new Set(group.unresolved_ids).size !== group.unresolved_ids.length ||
            (group.disposition === "blocked") !== (group.unresolved_ids.length > 0)) return result("invalid_disposition");
        if (group.disposition === "blocked") counts.blocked_groups++;
        const ranges = groups.get(group.requirement_id)!;
        const referenced = new Set<number>();
        for (const criterion of group.criteria) {
          counts.criteria++;
          if (ids.has(criterion.criterion_id)) return result("duplicate_criterion");
          ids.add(criterion.criterion_id);
          if (!criterion.statement.trim() || !criterion.verification_method.trim()) return result("blank_criterion");
          const basis = criterion.basis;
          if (basis.kind === "inference") {
            if (!basis.rationale.trim()) return result("blank_criterion");
            counts.inferences++;
            continue;
          }
          const first = basis.first_line, last = basis.last_line;
          if (first > last || !ranges.some(([start, end]) => first >= start && last <= end)) return result("invalid_locator");
          const excerpt = source.subarray(snapshot.lines[first - 1]!.byteStart, snapshot.lines[last - 1]!.byteEnd);
          if (sha256(excerpt) !== basis.quote_sha256) return result("quote_mismatch");
          for (let line = first; line <= last; line++) referenced.add(line);
          counts.source_references++;
        }
        for (const [first, last] of ranges) for (let line = first; line <= last; line++) {
          if (!referenced.has(line)) return result("source_coverage_missing");
        }
      }
      return result("traceability_complete");
    },
  });
}
