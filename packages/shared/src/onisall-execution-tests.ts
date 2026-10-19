/** Development qualification only. These constants confer no contract grant. */
export const ONISALL_EXECUTION_TEST_MODEL = "deepseek/deepseek-v4.1-flash";
export const ONISALL_EXECUTION_TEST_MARKER = "ONISALL_UI_EXECUTION_READY";
export const ONISALL_EXECUTION_TEST_PROMPT = `Reply with exactly ${ONISALL_EXECUTION_TEST_MARKER}. Do not call tools, access files, or perform any other action.`;
export const ONISALL_EXECUTION_TEST_REASON = "onisall_execution_test";
export const ONISALL_EXECUTION_TEST_BUNDLE = "d976c2ad89f93a2b81af4d150dca99aeedfd679f15e8b8c032314e61e484da7b";
export interface OnisallExecutionTestRun {
  id: string; status: string; startedAt: string | null; finishedAt: string | null;
}
export interface OnisallExecutionTestSlot {
  agentId: string; issueId: string; identifier: string; title: string;
  available: boolean; blockers: string[]; run: OnisallExecutionTestRun | null;
}
export interface OnisallExecutionTests {
  protocol: "onisall.execution-tests.v1"; companyId: string; evaluatedAt: string;
  model: string; prompt: string; maxRunsPerAgent: 4; maxTurns: 1; timeoutSec: 120;
  slots: OnisallExecutionTestSlot[];
}
export interface OnisallExecutionTestEvaluation {
  protocol: "onisall.execution-test-evaluation.v1"; companyId: string; agentId: string; issueId: string;
  run: OnisallExecutionTestRun; evaluatedAt: string;
  output: string | null; outputSha256: string | null;
  checks: { code: string; status: "pass" | "fail" | "pending" }[];
  verdict: "pass" | "fail" | "pending";
  requestedModel: string | null; cliReportedModels: string[]; actualModel: null;
  inputTokens: number | null; outputTokens: number | null;
  costStatus: "unpriced"; usageComplete: false; providerStop: "unknown";
  businessAcceptance: "not_evaluated"; independentReview: "not_configured";
  executionGrant: "not_granted";
}
