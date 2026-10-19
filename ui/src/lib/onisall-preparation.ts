import { ONISALL_INPUT_MAX_BYTES } from "@paperclipai/shared";
import type { CurrentBoardAccess } from "@/api/access";
import { ApiError } from "@/api/client";

export function isOnisallObjectId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** UI affordance only. The existing server rechecks actual permission grants. */
export function canPrepareOnisall(companyId: string, status: string | undefined, access: CurrentBoardAccess | undefined): boolean {
  if (status !== "active" || !access || access.keyId !== null) return false;
  if (access.source === "local_implicit" || access.isInstanceAdmin) return true;
  const member = access.memberships?.find((entry) => entry.companyId === companyId && entry.status === "active");
  return member?.membershipRole === "owner" || member?.membershipRole === "admin"
    || member?.membershipRole === "operator" || member?.membershipRole === "member";
}

export async function onisallFileBase64(file: File): Promise<string> {
  if (!file.size || file.size > ONISALL_INPUT_MAX_BYTES) throw new Error("请选择非空 UTF-8 文件，大小最多 1 MiB。");
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch { throw new Error("无法读取文件，请重新选择原文文件。"); }
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("文件需要严格 UTF-8 编码，请另存为 UTF-8 后重新选择。"); }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function onisallRequestError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return "当前身份没有此操作权限。请核对登录身份和公司成员资格。";
    if (error.status === 404) return "对象不存在，或在当前公司 / Project 中不可见。";
    if (error.status === 409) return "材料、原生状态或配置不一致。请重新读取并核对输入与目标，当前结果不能用于发布。";
    if (error.status === 400 || error.status === 422) return "输入未通过校验。请核对字段、文件编码与原文行数（最多 10000 行）。";
  }
  return "请求未完成，结果尚未确认。可重试同一操作；不要据此开始执行。";
}

export const onisallDiagnosticLabels: Record<string, string> = {
  pipeline_archived: "Pipeline 已归档", case_retired: "Case 已退役", case_terminal: "Case 已终结",
  case_left_entry_stage: "Case 已离开准备入口", entry_stage_missing: "入口 Stage 已缺失",
  entry_stage_unavailable: "入口 Stage 不可用于准备", current_stage_unavailable: "当前 Stage 不可用",
  preparation_configuration_changed: "准备配置已变更", automation_execution_exists: "已存在自动化执行记录",
  project_archived: "Project 已归档", project_paused: "Project 已暂停", project_terminal: "Project 已终结",
  native_pending: "尚无原生绑定", native_blocked: "原生当前状态有阻塞", binding_changed: "绑定已变更",
  input_changed: "输入版本已变更", case_head_changed: "Case 当前版本已变更", workflow_changed: "完整 workflow 配置已变更",
  native_current_head: "当前原生版本", contract_preflight: "完整契约预检", checks_and_independent_review: "检查与独立评审",
  human_decisions: "适用的人类决定", execution_qualification: "执行资格", budget_and_permissions: "预算与权限准入",
};
