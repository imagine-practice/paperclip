import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createOnisallIntakeDraftSchema, type OnisallBindingContext, type OnisallIntakeDraft } from "@paperclipai/shared";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { accessApi } from "@/api/access";
import { onisallIntakesApi } from "@/api/onisall-intakes";
import { onisallSchemaSetsApi } from "@/api/onisall-schema-sets";
import { pipelinesApi } from "@/api/pipelines";
import { queryKeys } from "@/lib/queryKeys";
import { canPrepareOnisall, isOnisallObjectId, onisallDiagnosticLabels, onisallFileBase64, onisallRequestError } from "@/lib/onisall-preparation";
import { relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { OnisallContractPreparations } from "@/components/OnisallContractPreparations";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/select";

const observationOptions = { retry: false, staleTime: 0, gcTime: 0, refetchOnMount: "always" as const };
function useLiveScope() {
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  return active;
}
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="flex flex-col gap-3 rounded-lg border border-border p-4"><h2 className="text-base font-semibold">{title}</h2>{children}</section>;
}
function ErrorMessage({ error }: { error: unknown }) {
  return error ? <p role="alert" className="text-sm text-destructive">{onisallRequestError(error)}</p> : null;
}
function Token({ children }: { children: ReactNode }) {
  return <span className="break-all font-mono text-xs">{children}</span>;
}
function ObservedAt({ at }: { at: string }) {
  return <p className="text-xs text-muted-foreground">观察于 <time dateTime={at} title={at}>{relativeTime(at)}</time>；仅表示该时点。</p>;
}

export function OnisallPreparation() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { intakeId } = useParams<{ intakeId?: string }>();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => { setBreadcrumbs([{ label: "OnisAll 输入准备", href: "/onisall/intakes" }, ...(intakeId ? [{ label: "草稿详情" }] : [])]); }, [intakeId, setBreadcrumbs]);
  if (!selectedCompanyId) return <p className="text-sm text-muted-foreground">先选择一个公司。</p>;
  return <PreparationScope key={`${selectedCompanyId}:${intakeId ?? "new"}`} companyId={selectedCompanyId} companyStatus={selectedCompany?.status} intakeId={intakeId} />;
}
function PreparationScope({ companyId, companyStatus, intakeId }: { companyId: string; companyStatus?: string; intakeId?: string }) {
  const access = useQuery({ queryKey: queryKeys.access.currentBoardAccess, queryFn: () => accessApi.getCurrentBoardAccess(), retry: false, staleTime: 0, refetchOnMount: "always" });
  const writable = !access.isError && !access.isFetching && canPrepareOnisall(companyId, companyStatus, access.data);
  return <div className="flex flex-col gap-6">
    <div className="flex flex-col gap-2"><h1 className="text-xl font-semibold">OnisAll 输入准备</h1>
      <p className="text-sm text-muted-foreground">保存原文、核对原生阶段和准备材料。准备结果不授予执行权，契约尚未发布。</p>
      <Link className="text-sm underline" to="/onisall/execution">打开模型开发测试与协议检查</Link>
      <Link className="text-sm underline" to="/onisall/rules">浏览执行规则材料</Link>
      {!writable && <p className="text-sm text-muted-foreground">当前为只读；写入需要活动公司与有效操作资格。</p>}
      <ErrorMessage error={access.error} />
    </div>
    {intakeId ? isOnisallObjectId(intakeId) ? <DraftDetails companyId={companyId} intakeId={intakeId} writable={writable} />
      : <p role="alert" className="text-sm text-destructive">草稿 ID 需要完整 UUID。</p>
      : <NewDraft companyId={companyId} writable={writable} />}
    <SchemaSetRead companyId={companyId} />
  </div>;
}
function NewDraft({ companyId, writable }: { companyId: string; writable: boolean }) {
  const navigate = useNavigate();
  const live = useLiveScope();
  const [goal, setGoal] = useState("");
  const [label, setLabel] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [openId, setOpenId] = useState("");
  const [validation, setValidation] = useState("");
  const save = useMutation({ retry: false,
    mutationFn: async () => {
      if (!writable || !file) throw new Error("Unavailable input");
      let contentBase64: string;
      try { contentBase64 = await onisallFileBase64(file); }
      catch (error) { if (live.current) setValidation(error instanceof Error ? error.message : "无法读取原文文件。"); throw error; }
      const payload = createOnisallIntakeDraftSchema.safeParse({ goal, sourceLabel: label, requestKey, contentBase64 });
      if (!payload.success) { if (live.current) setValidation("请填写目标和来源标签，并选择非空 UTF-8 原文（最多 1 MiB）。"); throw new Error("Invalid input"); }
      // Company may have changed while the file was read: do not start a write.
      if (!live.current) throw new Error("Scope closed");
      return onisallIntakesApi.create(companyId, payload.data);
    },
    onSuccess: ({ draft }) => { if (live.current) navigate(`/onisall/intakes/${draft.id}`); },
  });
  function changed() { setRequestKey(crypto.randomUUID()); setValidation(""); save.reset(); }
  return <>
    <Panel title="打开已有草稿"><form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (isOnisallObjectId(openId.trim())) navigate(`/onisall/intakes/${openId.trim()}`); }}>
      <label className="flex flex-col gap-1 text-sm">草稿 ID<Input value={openId} onChange={(event) => setOpenId(event.target.value)} placeholder="完整 UUID" /></label>
      <div className="flex justify-end"><Button type="submit" variant="outline" disabled={!isOnisallObjectId(openId.trim())}>打开草稿</Button></div>
    </form></Panel>
    <Panel title="保存新的输入"><form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); setValidation(""); save.mutate(); }}>
      <label className="flex flex-col gap-1 text-sm">交付目标<Textarea value={goal} maxLength={4000} disabled={!writable || save.isPending} onChange={(event) => { setGoal(event.target.value); changed(); }} /></label>
      <label className="flex flex-col gap-1 text-sm">来源标签<Input value={label} maxLength={200} disabled={!writable || save.isPending} onChange={(event) => { setLabel(event.target.value); changed(); }} /></label>
      <label className="flex flex-col gap-1 text-sm">原文文件<Input type="file" disabled={!writable || save.isPending} onChange={(event) => { const selected = event.target.files?.[0] ?? null; setFile(selected); if (selected) setLabel(selected.name.slice(0, 200)); changed(); }} /></label>
      <p className="text-xs text-muted-foreground">严格 UTF-8，最多 1 MiB / 10000 行。保存原始 BOM 和换行，文件名只作来源标签。</p>
      {validation && <p role="alert" className="text-sm text-destructive">{validation}</p>}<ErrorMessage error={save.error} />
      <div className="flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">失败时可重试同一输入；修改输入会开始新的逻辑操作。</span><Button type="submit" disabled={!writable || save.isPending || !file || !goal.trim() || !label.trim()}>{save.isPending ? "正在保存…" : "保存输入草稿"}</Button></div>
    </form></Panel>
  </>;
}
function DraftDetails({ companyId, intakeId, writable }: { companyId: string; intakeId: string; writable: boolean }) {
  const draft = useQuery({ queryKey: queryKeys.onisall.draft(companyId, intakeId), queryFn: ({ signal }) => onisallIntakesApi.get(companyId, intakeId, { signal, cache: "no-store" }), ...observationOptions, refetchOnWindowFocus: false, refetchOnReconnect: false });
  if (draft.isFetching) return <p className="text-sm text-muted-foreground">正在读取草稿…</p>;
  if (draft.isError || !draft.data) return <Panel title="读取草稿"><ErrorMessage error={draft.error} /><Button variant="outline" onClick={() => void draft.refetch()}>重新读取草稿</Button><Link to="/onisall/intakes">返回输入准备</Link></Panel>;
  const value = draft.data;
  return <>
    <Panel title={value.goal}><p className="text-sm">来源：{value.sourceLabel}</p><Token>{value.id}</Token>
      <p className="text-sm">{value.initialSnapshot.byteSize.toLocaleString()} 字节 · {value.initialSnapshot.lineCount.toLocaleString()} 行 · {value.initialSnapshot.hasBom ? "含 BOM" : "无 BOM"}</p>
      <Token>SHA-256 {value.initialSnapshot.sha256}</Token>
      <p className="text-sm">{value.binding ? "已保存准备绑定；当前原生状态见独立复验。" : "原生绑定待准备。"} 契约未发布，执行未授权。</p>
      <div className="flex flex-wrap gap-3"><a className="text-sm underline" href={onisallIntakesApi.contentPath(companyId, intakeId)} download>下载原始输入</a><Link className="text-sm underline" to="/onisall/intakes">返回输入准备</Link></div>
    </Panel>
    <InputStatus companyId={companyId} intakeId={intakeId} />
    <NativeStatus companyId={companyId} intakeId={intakeId} />
    {!value.binding && <PrepareBinding companyId={companyId} draft={value} writable={writable} />}
    <PreparationBaseline companyId={companyId} intakeId={intakeId} writable={writable && Boolean(value.binding)} />
    {value.binding && <OnisallContractPreparations key={`${companyId}:${intakeId}`} companyId={companyId} intakeId={intakeId} />}
  </>;
}
function InputStatus({ companyId, intakeId }: { companyId: string; intakeId: string }) {
  const query = useQuery({ queryKey: queryKeys.onisall.preparation(companyId, intakeId), queryFn: ({ signal }) => onisallIntakesApi.preparationStatus(companyId, intakeId, { signal }), ...observationOptions });
  const value = !query.isFetching && !query.isError ? query.data : undefined;
  return <Panel title="输入完整性与准备记录"><ErrorMessage error={query.error} />{query.isFetching && <p className="text-sm">正在回读原件并核验…</p>}
    {value && <><p className="text-sm">原件摘要、字节数和行数已回读核验。{value.nativeBinding.status === "recorded" ? "绑定记录存在。" : "绑定记录尚未建立。"}</p>
      <p className="text-sm">发布入口不可用 · 执行未授权</p>
      <p className="text-xs text-muted-foreground">本项未评估：{value.remainingChecks.map((check) => onisallDiagnosticLabels[check.code] ?? check.code).join("、")}。原生复验结果单独展示。</p><ObservedAt at={value.evaluatedAt} /></>}
    <div className="flex justify-end"><Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>重新核验输入</Button></div>
  </Panel>;
}
function NativeStatus({ companyId, intakeId }: { companyId: string; intakeId: string }) {
  const query = useQuery({ queryKey: queryKeys.onisall.native(companyId, intakeId), queryFn: ({ signal }) => onisallIntakesApi.nativeRevalidation(companyId, intakeId, { signal }), ...observationOptions });
  const value = !query.isFetching && !query.isError ? query.data : undefined;
  return <Panel title="原生当前版本复验"><ErrorMessage error={query.error} />{query.isFetching && <p className="text-sm">正在读取原生当前版本与配置…</p>}
    {value && <>{value.native.status === "pending" ? <p className="text-sm">尚无原生绑定，不能复验当前 Case。</p> : <>
      <p className="text-sm">{value.native.status === "consistent" ? "本次原生准备关系一致。" : "原生准备关系被阻塞。"}</p>
      <p className="text-sm">Case <Token>{value.native.head.caseId}</Token> · 版本 <Token>{value.native.head.version}</Token> · 当前 Stage <Token>{value.native.head.stageKey}</Token></p>
      <p className="text-sm">准备配置：{value.native.configuration.status === "matches_binding" ? "与绑定匹配" : "已变化"}；完整 workflow 的当前对比见指定基线。</p>
      {value.native.blockers.length > 0 && <ul className="list-disc pl-5 text-sm">{value.native.blockers.map((code) => <li key={code}>{onisallDiagnosticLabels[code] ?? code}</li>)}</ul>}
    </>}<ObservedAt at={value.evaluatedAt} /><p className="text-xs text-muted-foreground">这是时点诊断，不是可重放的发布凭据；契约未发布，执行未授权。</p></>}
    <div className="flex justify-end"><Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>重新复验原生状态</Button></div>
  </Panel>;
}
function PrepareBinding({ companyId, draft, writable }: { companyId: string; draft: OnisallIntakeDraft; writable: boolean }) {
  const live = useLiveScope();
  const cache = useQueryClient();
  const [pipelineId, setPipelineId] = useState("");
  const [stageKey, setStageKey] = useState("");
  const [context, setContext] = useState<OnisallBindingContext | null>(null);
  const pipelines = useQuery({ queryKey: ["onisall-binding-pipelines", companyId], queryFn: () => pipelinesApi.list(companyId), enabled: writable, retry: false, gcTime: 0 });
  const pipeline = useQuery({ queryKey: ["onisall-binding-pipeline", companyId, pipelineId], queryFn: () => pipelinesApi.get(pipelineId), enabled: writable && Boolean(pipelineId), retry: false, gcTime: 0 });
  const readContext = useMutation({ retry: false, mutationFn: () => onisallIntakesApi.bindingContext(companyId, draft.id, { pipelineId, entryStageKey: stageKey }),
    onSuccess: (result) => { if (live.current) setContext(result); }, onError: () => { if (live.current) setContext(null); } });
  const bind = useMutation({ retry: false, mutationFn: () => {
    if (!writable || !context || context.intakeId !== draft.id || context.inputSha256 !== draft.initialSnapshot.sha256) throw new Error("Invalid context");
    return onisallIntakesApi.bind(companyId, draft.id, { pipelineId: context.pipelineId, entryStageKey: context.entryStageKey, projectId: context.projectId, inputSha256: context.inputSha256, configurationHash: context.configurationHash });
  }, onSuccess: () => { if (live.current) void cache.invalidateQueries({ queryKey: queryKeys.onisall.intake(companyId, draft.id) }); },
  onError: () => { if (live.current) setContext(null); } });
  const busy = readContext.isPending || bind.isPending;
  function reset() { setContext(null); readContext.reset(); bind.reset(); }
  return <Panel title="准备原生绑定"><p className="text-xs text-muted-foreground">只接受有效且无入口自动化的 working Stage。服务端将核对 Project、原件和配置，再创建唯一 Case；不会开始执行。</p>
    <ErrorMessage error={pipelines.error ?? pipeline.error ?? readContext.error ?? bind.error} />
    <label className="flex flex-col gap-1 text-sm">Pipeline<NativeSelect aria-label="Pipeline" value={pipelineId} disabled={!writable || busy || pipelines.isFetching} onChange={(event) => { setPipelineId(event.target.value); setStageKey(""); reset(); }}><option value="">选择 Pipeline</option>{!pipelines.isError && pipelines.data?.filter((item) => !item.archivedAt).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</NativeSelect></label>
    <label className="flex flex-col gap-1 text-sm">入口 Stage<NativeSelect aria-label="入口 Stage" value={stageKey} disabled={!writable || busy || !pipelineId || pipeline.isFetching || pipeline.isError} onChange={(event) => { setStageKey(event.target.value); reset(); }}><option value="">选择入口 Stage</option>{!pipeline.isError && pipeline.data?.stages.filter((stage) => stage.kind === "working").map((stage) => <option key={stage.id} value={stage.key}>{stage.name}</option>)}</NativeSelect></label>
    {context && <><p className="text-sm">Project：<Token>{context.projectId ?? "公司自用"}</Token>；输入与配置已读取，提交时仍会再次核对。</p><Token>配置 SHA-256 {context.configurationHash}</Token></>}
    <div className="flex items-center justify-between gap-3"><Button variant="outline" disabled={!writable || busy || !pipelineId || !stageKey || pipeline.isError} onClick={() => readContext.mutate()}>读取绑定材料</Button><Button disabled={!writable || busy || !context} onClick={() => bind.mutate()}>{bind.isPending ? "正在绑定…" : "保存准备绑定"}</Button></div>
  </Panel>;
}
function PreparationBaseline({ companyId, intakeId, writable }: { companyId: string; intakeId: string; writable: boolean }) {
  const live = useLiveScope();
  const [params, setParams] = useSearchParams();
  const baselineId = params.get("baseline") ?? "";
  const [lookup, setLookup] = useState(baselineId);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [saved, setSaved] = useState(false);
  const query = useQuery({ queryKey: queryKeys.onisall.baseline(companyId, intakeId, baselineId), queryFn: ({ signal }) => onisallIntakesApi.preparationBaselineStatus(companyId, intakeId, baselineId, { signal }), enabled: isOnisallObjectId(baselineId), ...observationOptions });
  const save = useMutation({ retry: false, mutationFn: () => { if (!writable) throw new Error("Read only"); return onisallIntakesApi.createPreparationBaseline(companyId, intakeId, { requestKey }); },
    onSuccess: ({ baseline }) => { if (!live.current) return; setSaved(true); setLookup(baseline.id); const next = new URLSearchParams(params); next.set("baseline", baseline.id); setParams(next); } });
  const value = !query.isFetching && !query.isError ? query.data : undefined;
  function read(event: FormEvent) { event.preventDefault(); if (!isOnisallObjectId(lookup.trim())) return; const next = new URLSearchParams(params); next.set("baseline", lookup.trim()); if (baselineId === lookup.trim()) void query.refetch(); else setParams(next); }
  return <Panel title="完整 workflow 准备基线"><p className="text-xs text-muted-foreground">保存服务端实际观察的输入、Case 版本和完整 workflow 材料；之后读取指定历史基线并与当前状态对比。</p>
    <ErrorMessage error={save.error ?? query.error} />
    <form className="flex flex-col gap-3" onSubmit={read}><label className="flex flex-col gap-1 text-sm">基线 ID<Input value={lookup} onChange={(event) => setLookup(event.target.value)} placeholder="完整 UUID" /></label><div className="flex items-center justify-between gap-3"><Button type="submit" variant="outline" disabled={!isOnisallObjectId(lookup.trim()) || query.isFetching}>读取并对比基线</Button>
      {saved ? <Button type="button" variant="outline" disabled={!writable} onClick={() => { setRequestKey(crypto.randomUUID()); setSaved(false); save.reset(); }}>准备另存新基线</Button> : <Button type="button" disabled={!writable || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "正在保存…" : "保存准备基线"}</Button>}</div></form>
    {query.isFetching && <p className="text-sm">正在核验历史字节并读取当前状态…</p>}
    {value && <><p className="text-sm">{value.comparison.status === "matches" ? "指定基线与本次当前观察匹配。" : "指定基线与本次当前观察存在变化。"}</p><Token>{value.baseline.id}</Token><Token>基线 SHA-256 {value.baseline.baselineHash}</Token>
      <p className="text-sm">冻结 Case 版本 <Token>{value.baseline.caseVersion}</Token>；输入 SHA-256 <Token>{value.baseline.inputSha256}</Token></p>
      {value.comparison.changes.length > 0 && <ul className="list-disc pl-5 text-sm">{value.comparison.changes.map((change) => <li key={change}>{onisallDiagnosticLabels[change] ?? change}</li>)}</ul>}
      <ObservedAt at={value.evaluatedAt} /><p className="text-xs text-muted-foreground">历史材料及当前匹配都不保证未来发布条件；执行未授权。</p></>}
  </Panel>;
}
function SchemaSetRead({ companyId }: { companyId: string }) {
  const [lookup, setLookup] = useState("");
  const [id, setId] = useState("");
  const query = useQuery({ queryKey: queryKeys.onisall.schemaSet(companyId, id), queryFn: ({ signal }) => onisallSchemaSetsApi.get(companyId, id, { signal }), enabled: isOnisallObjectId(id), ...observationOptions });
  const value = !query.isFetching && !query.isError ? query.data : undefined;
  return <Panel title="受信 Schema 集合核验"><p className="text-xs text-muted-foreground">读取部署时保存的公司规则材料；此处不上传或注册规则，也不等同于完整契约冻结。</p>
    <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (!isOnisallObjectId(lookup.trim())) return; if (id === lookup.trim()) void query.refetch(); else setId(lookup.trim()); }}><label className="flex flex-col gap-1 text-sm">Schema 集合 ID<Input value={lookup} onChange={(event) => setLookup(event.target.value)} placeholder="完整 UUID" /></label><div className="flex justify-end"><Button type="submit" variant="outline" disabled={!isOnisallObjectId(lookup.trim()) || query.isFetching}>核验 Schema 集合</Button></div></form>
    <ErrorMessage error={query.error} />{query.isFetching && <p className="text-sm">正在核验规则材料…</p>}
    {value && <><p className="text-sm">存储完整性已核验；{value.set.schemaCount} 份规则，{value.set.totalByteSize.toLocaleString()} 字节。</p><Token>{value.set.id}</Token><Token>集合 SHA-256 {value.set.manifestSha256}</Token>
      <p className="text-sm">{value.currentCompiler.matchesFrozenProfile ? "当前编译 profile 与冻结 profile 相同。" : "当前编译 profile 已变化，旧集合未自动升级。"} 字节核验不等于重新编译通过。</p><ObservedAt at={value.evaluatedAt} /></>}
  </Panel>;
}
