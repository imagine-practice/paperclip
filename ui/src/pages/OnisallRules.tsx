import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OnisallRuleKind } from "@paperclipai/shared";
import { Link, useParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { onisallRuleSetsApi } from "@/api/onisall-rule-sets";
import { isOnisallObjectId, onisallRequestError } from "@/lib/onisall-preparation";
import { relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const options = { retry: false, staleTime: 0, gcTime: 0, refetchOnMount: "always" as const, refetchOnWindowFocus: false, refetchOnReconnect: false };
const labels: Record<OnisallRuleKind, string> = { check: "检查器", command: "验证命令", runtime: "运行时", policy: "隔离策略" };
export function OnisallRules() {
  const { selectedCompanyId } = useCompany();
  const { ruleSetId } = useParams<{ ruleSetId?: string }>();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => { setBreadcrumbs([{ label: "OnisAll 执行规则", href: "/onisall/rules" }, ...(ruleSetId ? [{ label: "规则集合" }] : [])]); }, [ruleSetId, setBreadcrumbs]);
  if (!selectedCompanyId) return <p className="text-sm text-muted-foreground">先选择一个公司。</p>;
  return <div className="flex flex-col gap-6">
    <div className="flex flex-col gap-2"><h1 className="text-xl font-semibold">OnisAll 执行规则材料</h1>
      <p className="text-sm text-muted-foreground">核对契约所依赖的检查器、命令、运行时与策略。材料核验不授予执行权。</p>
      <div className="flex flex-wrap gap-3 text-sm underline"><Link to="/onisall/intakes">输入准备</Link><Link to="/onisall/execution">模型开发测试</Link></div>
    </div>
    {ruleSetId ? isOnisallObjectId(ruleSetId) ? <Details key={`${selectedCompanyId}:${ruleSetId}`} companyId={selectedCompanyId} id={ruleSetId} />
      : <p role="alert" className="text-sm text-destructive">规则集合 ID 无效。</p>
      : <Catalog key={selectedCompanyId} companyId={selectedCompanyId} />}
  </div>;
}
function ErrorMessage({ error }: { error: unknown }) {
  return error ? <p role="alert" className="text-sm text-destructive">{onisallRequestError(error)}</p> : null;
}
function Catalog({ companyId }: { companyId: string }) {
  const [offset, setOffset] = useState(0);
  const query = useQuery({ queryKey: ["onisall", "rule-catalog", companyId, offset],
    queryFn: ({ signal }) => onisallRuleSetsApi.list(companyId, offset, { signal }), ...options });
  const value = !query.isFetching && !query.isError ? query.data : undefined;
  return <section className="flex flex-col gap-3">
    <h2 className="text-base font-semibold">已保存的规则集合</h2>
    <p className="text-xs text-muted-foreground">目录列出历史记录；打开集合才回读实际字节并核验。</p>
    <ErrorMessage error={query.error} />{query.isFetching && <p className="text-sm">正在读取规则目录…</p>}
    {value && <>{value.sets.length ? <ul className="flex flex-col gap-3">{value.sets.map(set => <li className="flex flex-col gap-1 rounded-lg border border-border p-4" key={set.id}>
      <Link className="text-sm underline" to={`/onisall/rules/${set.id}`}>打开规则集合 · {set.assetCount} 件资产</Link>
      <span className="text-xs text-muted-foreground">保存于 <time dateTime={set.createdAt} title={set.createdAt}>{relativeTime(set.createdAt)}</time> · {set.totalByteSize.toLocaleString()} 字节 · 准备材料</span>
      <span className="break-all font-mono text-xs">SHA-256 {set.manifestSha256}</span>
    </li>)}</ul> : <p className="text-sm text-muted-foreground">当前公司尚无规则集合。受信部署完成后会显示在此目录。</p>}
      <p className="text-xs text-muted-foreground">目录读取于 <time dateTime={value.evaluatedAt}>{relativeTime(value.evaluatedAt)}</time>。</p></>}
    <div className="flex items-center justify-between gap-3"><Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>刷新规则目录</Button>
      <div className="flex gap-3"><Button variant="outline" disabled={query.isFetching || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</Button>
        <Button variant="outline" disabled={!value || value.nextOffset === null} onClick={() => { if (value?.nextOffset !== null && value?.nextOffset !== undefined) setOffset(value.nextOffset); }}>下一页</Button></div>
    </div>
  </section>;
}
function Details({ companyId, id }: { companyId: string; id: string }) {
  const query = useQuery({ queryKey: ["onisall", "rule-set", companyId, id], queryFn: ({ signal }) => onisallRuleSetsApi.get(companyId, id, { signal }), ...options });
  const value = !query.isFetching && !query.isError ? query.data : undefined;
  return <section className="flex flex-col gap-3">
    <h2 className="text-base font-semibold">规则集合核验</h2><ErrorMessage error={query.error} />
    {query.isFetching && <p className="text-sm">正在回读实际规则字节并重建 registry…</p>}
    {value && <>
      <p className="text-sm">集合 manifest、成员引用、实际字节和 registry 已核验。</p>
      <p className="text-sm">{value.preparation.schemaCompilation === "verified" ? "关联 Schema 已按当前编译器重新编译。" : "Schema 编译 profile 已变化；历史材料未升级，需重新准备。"}</p>
      <p className="text-sm">契约未发布，执行未授权；业务语义验收及实际隔离尚未评估。</p>
      <p className="text-xs text-muted-foreground">检查器的目标类型表示机械检查范围。来源追溯检查只能证明引用与覆盖；策略字节存在不能证明运行时隔离。</p>
      <span className="break-all font-mono text-xs">集合 SHA-256 {value.set.manifestSha256}</span>
      <ul className="flex flex-col gap-3">{value.set.assets.map(asset => <li className="flex flex-col gap-1 rounded-lg border border-border p-4" key={`${asset.kind}:${asset.registryKey}:${asset.revision}`}>
        <h3 className="text-sm font-semibold">{labels[asset.kind]} · {asset.registryKey}</h3>
        <p className="text-xs">版本 {asset.revision} · {asset.byteSize.toLocaleString()} 字节</p><span className="break-all font-mono text-xs">SHA-256 {asset.sha256}</span>
        {asset.check && <p className="text-xs">目标：{asset.check.targetKinds.join("、")} · {asset.check.evidenceMode === "machine" ? "机器证据" : "受认证人类证据"}</p>}
      </li>)}</ul>
      <p className="text-xs text-muted-foreground">核验于 <time dateTime={value.evaluatedAt} title={value.evaluatedAt}>{relativeTime(value.evaluatedAt)}</time>；时点诊断不能作为发布或执行凭据。</p>
    </>}
    <div className="flex items-center justify-between gap-3"><Link className="text-sm underline" to="/onisall/rules">返回规则目录</Link>
      <Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>重新核验规则字节</Button></div>
  </section>;
}
