import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OnisallExecutionTestSlot } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { accessApi } from "@/api/access";
import { heartbeatsApi } from "@/api/heartbeats";
import { onisallExecutionTestsApi as executionApi } from "@/api/onisall-execution-tests";
import { canPrepareOnisall } from "@/lib/onisall-preparation";
import { Button } from "@/components/ui/button";

const labels: Record<string, string> = {
  company_inactive: "公司未处于活动状态", agent_unavailable: "执行器当前不可用", configuration_changed: "执行配置已变化",
  company_runs_active: "先等待公司当前 Run 结束", scheduled_retry: "等待原生恢复",
  slot_changed: "测试任务已变化", single_use_dispatched: "此槽位已发起执行", allowance_exhausted: "开发调用额度已用完",
  queued: "排队中", running: "执行中", succeeded: "执行成功", failed: "执行失败", timed_out: "执行超时", cancelled: "已取消",
  native_run_succeeded: "原生 Run 成功且退出码为 0", execution_protocol: "执行输出协议", native_scope: "公司、Agent、任务和 Run 归属",
  pinned_cli: "已固定的 CLI 版本与摘要", requested_model: "请求的模型配置", exact_output: "实际输出精确匹配", local_process_exit: "本地进程退出与输出关闭",
  pass: "通过", fail: "失败", pending: "等待结果",
};
const active = (status: string) => ["queued", "running", "scheduled_retry"].includes(status);
const readOptions = { retry: false, staleTime: 0, gcTime: 0, refetchOnMount: "always" as const };
export function OnisallExecution() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => { setBreadcrumbs([{ label: "OnisAll 模型测试", href: "/onisall/execution" }]); }, [setBreadcrumbs]);
  if (!selectedCompanyId) return <p>先选择一个公司。</p>;
  return <ExecutionScope key={selectedCompanyId} companyId={selectedCompanyId} companyStatus={selectedCompany?.status} />;
}
function ExecutionScope({ companyId, companyStatus }: { companyId: string; companyStatus?: string }) {
  const cache = useQueryClient(), live = useRef(true), busy = useRef(false), pollStarted = useRef(Date.now());
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [selected, setSelected] = useState<string | null>(null), [attempted, setAttempted] = useState<string[]>([]);
  const [writeNotice, setWriteNotice] = useState("");
  const key = ["onisall-execution-tests", companyId];
  const access = useQuery({ queryKey: ["current-board-access", "onisall-execution", companyId], queryFn: () => accessApi.getCurrentBoardAccess(), ...readOptions });
  const writable = !access.isFetching && !access.isError && canPrepareOnisall(companyId, companyStatus, access.data);
  const list = useQuery({ queryKey: key, queryFn: ({ signal }) => executionApi.list(companyId, { signal }), ...readOptions,
    refetchInterval: (query) => Date.now() - pollStarted.current < 180000 && query.state.data?.slots.some(slot => slot.run && active(slot.run.status)) ? 2000 : false });
  const data = !list.isFetching && !list.isError ? list.data : undefined;
  const slot = data?.slots.find(entry => entry.issueId === selected);
  const start = useMutation({ retry: false, mutationFn: async (entry: OnisallExecutionTestSlot) => {
    if (!live.current || busy.current || !writable || !entry.available || attempted.includes(entry.issueId)) throw new Error("Unavailable slot");
    busy.current = true; setAttempted(previous => [...previous, entry.issueId]); setSelected(entry.issueId); setWriteNotice("");
    try { return await executionApi.invoke(companyId, entry.agentId, entry.issueId); }
    finally { busy.current = false; }
  }, onSuccess: (result) => {
    if (!live.current) return;
    setWriteNotice("id" in result ? "已发起原生 Run；正在读取实际结果。" : "原生服务未发起 Run；请核对任务和执行器状态。");
    pollStarted.current = Date.now(); void cache.invalidateQueries({ queryKey: key });
  }, onError: () => { if (live.current) { setWriteNotice("执行请求未确认或被拒绝。请刷新只读结果核对已有 Run；不要重复执行。"); void cache.invalidateQueries({ queryKey: key }); } } });
  return <div className="flex flex-col gap-6">
    <div className="flex flex-col gap-2"><h1 className="text-xl font-semibold">OnisAll 模型测试与检查</h1>
      <p className="text-sm text-muted-foreground">手动执行开发文本探针，查看真实输出与协议检查。业务语义验收尚未评估，正式 W1 未获得执行授权。</p>
      <Link className="text-sm underline" to="/onisall/intakes">打开输入准备工作台</Link>
    </div>
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4"><h2 className="text-base font-semibold">开发执行范围</h2>
      <p className="text-sm">CommandCode · DeepSeek V4.1 Flash · 每次 1 回合 / 120 秒 · 每个专用执行器最多 4 次，每槽位只用一次。</p>
      <p className="text-sm text-muted-foreground">费用未定价，用量记录不完整；次数和超时不代表金额上限。当前隔离与 provider 停止仍未资格化。只执行下方固定文本，不处理上传的业务需求。</p>
      {data && <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">{data.prompt}</pre>}
      {!writable && <p className="text-sm">当前只读；执行需要活动公司和原生操作权限。</p>}
    </section>
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4"><h2 className="text-base font-semibold">原生测试任务</h2>
      {(list.isError || access.isError) && <p role="alert" className="text-sm text-destructive">无法读取当前权限或任务。刷新后重新核对。</p>}
      {list.isFetching && <p className="text-sm">正在读取当前任务与 Run…</p>}
      {data && data.slots.length === 0 && <p className="text-sm">当前公司没有已配置的开发测试槽位。</p>}
      {data?.slots.map(entry => <div key={entry.issueId} className="flex flex-col gap-2 border-b border-border pb-3">
        <Link to={`/issues/${entry.identifier}`} className="text-sm underline">{entry.identifier} · {entry.title}</Link>
        <Link to={`/agents/${entry.agentId}`} className="text-xs underline">查看执行器状态与配置</Link>
        <p className="text-sm">{entry.run ? labels[entry.run.status] ?? entry.run.status : "尚未执行"}</p>
        {entry.blockers.length > 0 && <p className="text-xs text-muted-foreground">{entry.blockers.map(code => labels[code] ?? code).join("；")}</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={!writable || !entry.available || start.isPending || attempted.includes(entry.issueId)} onClick={() => start.mutate(entry)}>执行 {entry.identifier}</Button>
          {entry.run && <Button variant="outline" onClick={() => setSelected(entry.issueId)}>查看 {entry.identifier} 结果</Button>}
        </div>
      </div>)}
      {writeNotice && <p role="status" className="text-sm">{writeNotice}</p>}
      <div className="flex justify-end"><Button variant="outline" disabled={list.isFetching} onClick={() => { pollStarted.current = Date.now(); void list.refetch(); void access.refetch(); }}>刷新任务与 Run</Button></div>
    </section>
    {slot?.run && <RunEvaluation key={slot.run.id} companyId={companyId} slot={slot} writable={writable} />}
  </div>;
}
function RunEvaluation({ companyId, slot, writable }: { companyId: string; slot: OnisallExecutionTestSlot; writable: boolean }) {
  const runId = slot.run!.id, pollStarted = useRef(Date.now());
  const evaluation = useQuery({ queryKey: ["onisall-execution-test-evaluation", companyId, runId], queryFn: ({ signal }) => executionApi.evaluate(companyId, runId, { signal }), ...readOptions,
    refetchInterval: (query) => Date.now() - pollStarted.current < 180000 && query.state.data?.verdict === "pending" ? 2000 : false });
  const value = !evaluation.isFetching && !evaluation.isError ? evaluation.data : undefined;
  const stop = useMutation({ retry: false, mutationFn: () => heartbeatsApi.cancel(runId), onSettled: () => { void evaluation.refetch(); } });
  return <section className="flex flex-col gap-3 rounded-lg border border-border p-4"><h2 className="text-base font-semibold">{slot.identifier} · 实际输出与协议检查</h2>
    <Link className="text-sm underline" to={`/agents/${slot.agentId}/runs/${runId}`}>打开原生 Run 详情</Link>
    {evaluation.isError && <p role="alert" className="text-sm text-destructive">当前检查结果读取失败，先重新读取。</p>}
    {evaluation.isFetching && <p className="text-sm">正在读取原生输出并检查…</p>}
    {value && <>
      <p className="text-sm">Run：{labels[value.run.status] ?? value.run.status} · 协议检查：{labels[value.verdict]}</p>
      <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm">{value.output ?? "尚无实际输出"}</pre>
      <ul className="list-disc pl-5 text-sm">{value.checks.map(check => <li key={check.code}>{labels[check.code] ?? check.code}：{labels[check.status]}</li>)}</ul>
      <p className="text-xs text-muted-foreground">输入 tokens：{value.inputTokens ?? "未知"}；输出 tokens：{value.outputTokens ?? "未知"}。费用：未定价；用量完整性：未验证。</p>
      <p className="text-xs text-muted-foreground">CLI 报告模型：{value.cliReportedModels.join("，") || "未知"}；provider 实际模型未证明。</p>
      <p className="text-sm">业务语义验收：未评估；独立评审：未配置；正式执行 grant：未授予；provider 停止：未知。</p>
      <p className="text-xs text-muted-foreground">检查于 {value.evaluatedAt}；下载是时点诊断证据，不是可重放的发布或执行凭据。</p>
      <a className="text-sm underline" href={executionApi.evidencePath(companyId, runId)} download>下载检查证据 JSON</a>
      {active(value.run.status) && <Button variant="outline" disabled={!writable || stop.isPending || stop.isSuccess} onClick={() => stop.mutate()}>请求停止本地 Run</Button>}
    </>}
    {stop.isError && <p role="alert" className="text-sm text-destructive">停止请求被拒绝或未确认；provider 停止状态仍未知。</p>}
    {stop.isSuccess && <p className="text-sm">已发送停止请求；provider 停止状态仍未知。</p>}
    <div className="flex justify-end"><Button variant="outline" disabled={evaluation.isFetching} onClick={() => { pollStarted.current = Date.now(); void evaluation.refetch(); }}>重新读取检查结果</Button></div>
  </section>;
}
