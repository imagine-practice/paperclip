import { ONISALL_EXECUTION_TEST_REASON, type HeartbeatRun, type OnisallExecutionTests, type OnisallExecutionTestEvaluation } from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";
const base = (companyId: string) => `/companies/${encodeURIComponent(companyId)}/onisall/execution-tests`;
export const onisallExecutionTestsApi = {
  list: (companyId: string, options?: RequestOptions) => api.get<OnisallExecutionTests>(base(companyId), { cache: "no-store", ...options }),
  evaluate: (companyId: string, runId: string, options?: RequestOptions) => api.get<OnisallExecutionTestEvaluation>(`${base(companyId)}/runs/${encodeURIComponent(runId)}/evaluation`, { cache: "no-store", ...options }),
  // Native wake route owns permission, admission, Run creation and dispatch.
  invoke: (companyId: string, agentId: string, issueId: string) => api.post<HeartbeatRun | { status: "skipped" }>(
    `/agents/${encodeURIComponent(agentId)}/heartbeat/invoke?companyId=${encodeURIComponent(companyId)}`,
    { reason: ONISALL_EXECUTION_TEST_REASON, payload: { issueId }, triggerDetail: "manual", forceFreshSession: true,
      idempotencyKey: `onisall-execution-test:${issueId}` }),
  evidencePath: (companyId: string, runId: string) => `/api${base(companyId)}/runs/${encodeURIComponent(runId)}/evidence`,
};
