import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "@/lib/router";
import { onisallContractPreparationsApi } from "@/api/onisall-contract-preparations";
import { isOnisallObjectId, onisallRequestError, onisallDiagnosticLabels } from "@/lib/onisall-preparation";
import { relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const options = { retry: false, staleTime: 0, gcTime: 0, refetchOnMount: "always" as const,
  refetchOnWindowFocus: false, refetchOnReconnect: false };
const labels: Record<string, string> = { ...onisallDiagnosticLabels,
  company_inactive: "公司已暂停或归档", compiler_profile_changed: "编译器 profile 已变化" };
function ErrorMessage({ error }: { error: unknown }) {
  return error ? <p role="alert" className="text-sm text-destructive">{onisallRequestError(error)}</p> : null;
}
export function OnisallContractPreparations({ companyId, intakeId }: { companyId: string; intakeId: string }) {
  const [params, setParams] = useSearchParams(), [offset, setOffset] = useState(0);
  const id = params.get("contractPreparation") ?? "";
  const catalog = useQuery({ queryKey: ["onisall", "contract-preparations", companyId, intakeId, offset],
    queryFn: ({ signal }) => onisallContractPreparationsApi.list(companyId, intakeId, offset, { signal }), ...options });
  const value = !catalog.isFetching && !catalog.isError ? catalog.data : undefined;
  return <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
    <h2 className="text-base font-semibold">完整契约准备</h2>
    <p className="text-sm text-muted-foreground">查看受信部署保存的候选，核对完整材料及当前变化。候选未正式发布，执行未授权。</p>
    <p className="text-xs text-muted-foreground">目录展示历史记录；打开候选才会回读输入与规则字节，并重新计算完整预检。</p>
    <ErrorMessage error={catalog.error} />{catalog.isFetching && <p className="text-sm">正在读取候选目录…</p>}
    {value && <>{value.preparations.length ? <ul className="flex flex-col gap-3">{value.preparations.map(item => <li key={item.id} className="flex flex-col gap-1">
      <Button variant="outline" onClick={() => { const next = new URLSearchParams(params); next.set("contractPreparation", item.id); setParams(next); }}>核验候选 · {item.id.slice(0, 8)}</Button>
      <p className="text-xs text-muted-foreground">保存于 <time dateTime={item.createdAt} title={item.createdAt}>{relativeTime(item.createdAt)}</time> · {item.candidateByteSize.toLocaleString()} 字节 · 准备记录</p>
      <span className="break-all font-mono text-xs">候选 SHA-256 {item.candidateSha256}</span>
    </li>)}</ul> : <p className="text-sm text-muted-foreground">此输入尚无契约候选。准备材料由受信部署写入。</p>}</>}
    <div className="flex items-center justify-between gap-3"><Button variant="outline" disabled={catalog.isFetching} onClick={() => void catalog.refetch()}>刷新候选目录</Button>
      <div className="flex gap-3"><Button variant="outline" disabled={catalog.isFetching || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页候选</Button>
        <Button variant="outline" disabled={!value || value.nextOffset === null} onClick={() => { if (value?.nextOffset != null) setOffset(value.nextOffset); }}>下一页候选</Button></div></div>
    {id && (isOnisallObjectId(id) ? <Details key={`${companyId}:${intakeId}:${id}`} companyId={companyId} intakeId={intakeId} id={id} />
      : <p role="alert" className="text-sm text-destructive">候选 ID 无效。</p>)}
  </section>;
}
function Details({ companyId, intakeId, id }: { companyId: string; intakeId: string; id: string }) {
  const query = useQuery({ queryKey: ["onisall", "contract-preparation", companyId, intakeId, id],
    queryFn: ({ signal }) => onisallContractPreparationsApi.get(companyId, intakeId, id, { signal }), ...options });
  const value = !query.isFetching && !query.isError ? query.data : undefined;
  return <div className="flex flex-col gap-3">
    <h3 className="text-sm font-semibold">候选实际复验</h3><ErrorMessage error={query.error} />
    {query.isFetching && <p className="text-sm">正在回读实际输入和规则材料，核对候选与基线…</p>}
    {value && <>
      <p className="text-sm">历史候选字节及依赖材料已核验。</p>
      <p className="text-sm">{value.preflight.status === "verified" ? "完整离线预检已重新计算。" : "编译器 profile 已变化，历史候选未自动升级。"}</p>
      <p className="text-sm">{value.current.status === "matches" ? "候选基线与本次当前观察匹配。" : "候选基线与当前状态存在变化。"}</p>
      {value.current.changes.length > 0 && <ul className="list-disc pl-5 text-sm">{value.current.changes.map(code => <li key={code}>{labels[code] ?? code}</li>)}</ul>}
      <p className="text-sm">计划最多 {value.preflight.maximumChecks} 项检查 · 产物类型：{value.preflight.artifactKinds.join("、")}</p>
      <p className="text-sm">契约未正式发布，执行未授权；业务语义、实际隔离与独立评审尚未验收。</p>
      <details><summary className="cursor-pointer text-sm">候选身份与完整摘要</summary><div className="flex flex-col gap-1">
        <span className="break-all font-mono text-xs">候选契约 {value.preparation.contractId} · 拟发布版本 {value.preparation.contractRevision}</span>
        <span className="break-all font-mono text-xs">候选 SHA-256 {value.preparation.candidateSha256}</span>
        <span className="break-all font-mono text-xs">依赖 SHA-256 {value.preparation.dependenciesSha256}</span>
        <span className="break-all font-mono text-xs">验收投影 SHA-256 {value.preparation.acceptanceCriteriaHash}</span>
        <span className="break-all font-mono text-xs">检查计划 SHA-256 {value.preparation.checkPlanSha256}</span>
        <span className="break-all font-mono text-xs">预检快照 SHA-256 {value.preparation.preflightSha256}</span>
      </div></details>
      <Link className="text-sm underline" to={`/onisall/rules/${value.preparation.ruleSetId}`}>查看关联执行规则</Link>
      <p className="text-xs text-muted-foreground">复验于 <time dateTime={value.evaluatedAt} title={value.evaluatedAt}>{relativeTime(value.evaluatedAt)}</time>；此结果不是发布或执行凭据。</p>
    </>}
    <div className="flex justify-end"><Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>重新复验候选</Button></div>
  </div>;
}
