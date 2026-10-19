// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnisallIntakeDraft, OnisallNativeRevalidation, OnisallPreparationBaseline, OnisallPreparationBaselineStatus, OnisallPreparationStatus } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { OnisallPreparation } from "./OnisallPreparation";

const ID = "00000000-0000-4000-8000-000000000001";
const BASELINE = "00000000-0000-4000-8000-000000000002";
const PIPELINE = "00000000-0000-4000-8000-000000000003";
const SHA = "a".repeat(64);
const AT = "2026-10-10T06:20:00.000Z";
const scope = vi.hoisted(() => ({ companyId: "company-a", status: "active", role: "operator" }));
const mocks = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), preparationStatus: vi.fn(), nativeRevalidation: vi.fn(), createPreparationBaseline: vi.fn(), preparationBaselineStatus: vi.fn(), bindingContext: vi.fn(), bind: vi.fn(), schemas: vi.fn(), listPipelines: vi.fn(), getPipeline: vi.fn() }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: scope.companyId, selectedCompany: { id: scope.companyId, issuePrefix: "ONI", status: scope.status } }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => undefined }) }));
vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: async () => ({ userId: "human", companyIds: [scope.companyId], source: "session", isInstanceAdmin: false, keyId: null, memberships: [{ companyId: scope.companyId, membershipRole: scope.role, status: "active" }] }) } }));
vi.mock("@/api/onisall-intakes", () => ({ onisallIntakesApi: { ...mocks, contentPath: (companyId: string, id: string) => `/api/companies/${companyId}/onisall/intakes/${id}/content` } }));
vi.mock("@/api/onisall-schema-sets", () => ({ onisallSchemaSetsApi: { get: mocks.schemas } }));
vi.mock("@/api/pipelines", () => ({ pipelinesApi: { list: mocks.listPipelines, get: mocks.getPipeline } }));
vi.mock("@/api/onisall-contract-preparations", () => ({ onisallContractPreparationsApi: {
  list: async (companyId: string, intakeId: string) => ({ protocol: "onisall.contract-preparation-catalog.v1", companyId, intakeId, preparations: [], nextOffset: null })
} }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function draft(bound = true): OnisallIntakeDraft {
  return { kind: "intake_draft", draftVersion: 2, id: ID, companyId: scope.companyId, businessKey: "manual-input.v1:sample", goal: "测试输入", sourceLabel: "input.txt", status: "draft", bindingStatus: bound ? "bound" : "binding_pending", controlMode: "native_pipeline", clientId: null, projectId: null, caseId: bound ? ID : null, contractId: null, createdAt: AT,
    initialSnapshot: { id: ID, companyId: scope.companyId, protocol: "onisall.input-text.v1", sha256: SHA, byteSize: 7, lineCount: 2, hasBom: true, createdAt: AT },
    binding: bound ? { id: ID, companyId: scope.companyId, intakeId: ID, snapshotId: ID, inputSha256: SHA, pipelineId: PIPELINE, projectId: null, caseId: ID, entryStageKey: "prepare", configurationHash: SHA, revision: 1, purpose: "preparation", executionAdmission: "not_granted", createdAt: AT } : null };
}
function preparation(): OnisallPreparationStatus {
  return { protocol: "onisall.intake-preparation-status.v1", evaluatedAt: AT, diagnosticsOnly: true, companyId: scope.companyId, intakeId: ID, input: { status: "verified", snapshotId: ID, sha256: SHA, byteSize: 7, lineCount: 2 }, nativeBinding: { status: "recorded", bindingId: ID, caseId: ID, revision: 1 }, publication: { status: "unavailable", reason: "publication_not_implemented", executionAdmission: "not_granted" }, remainingChecks: [{ code: "checks_and_independent_review", status: "not_evaluated" }] };
}
function native(): OnisallNativeRevalidation {
  return { protocol: "onisall.native-revalidation.v1", evaluatedAt: AT, companyId: scope.companyId, intakeId: ID, diagnosticsOnly: true, input: preparation().input, publication: preparation().publication,
    native: { status: "consistent", blockers: [], bindingId: ID, bindingRevision: 1, head: { caseId: ID, version: 3, pipelineId: PIPELINE, projectId: null, stageId: ID, stageKey: "prepare", stageKind: "working", retired: false, terminalKind: null }, configuration: { status: "matches_binding", bindingHash: SHA, currentBindingHash: SHA, workflowHash: SHA, workflowBaseline: "not_frozen" } } };
}
function baseline(): OnisallPreparationBaseline {
  return { protocol: "onisall.preparation-baseline.v1", id: BASELINE, companyId: scope.companyId, intakeId: ID, bindingId: ID, bindingRevision: 1, snapshotId: ID, inputSha256: SHA, caseId: ID, caseVersion: 3, pipelineId: PIPELINE, projectId: null, stageId: ID, stageKey: "prepare", bindingConfigurationHash: SHA, workflowHash: SHA, baselineHash: SHA, purpose: "preparation", executionAdmission: "not_granted", createdAt: AT };
}
function baselineStatus(): OnisallPreparationBaselineStatus {
  return { protocol: "onisall.preparation-baseline-status.v1", evaluatedAt: AT, diagnosticsOnly: true, baseline: baseline(), comparison: { status: "matches", changes: [] }, native: native().native, publication: preparation().publication };
}

let container: HTMLDivElement;
let root: Root;
let cache: QueryClient;
function Location() { const location = useLocation(); return <output data-testid="location">{location.pathname}{location.search}</output>; }
function Tree({ path }: { path: string }) {
  return <QueryClientProvider client={cache}><MemoryRouter initialEntries={[path]}><Location /><Routes><Route path="/:companyPrefix/onisall/intakes" element={<OnisallPreparation />} /><Route path="/:companyPrefix/onisall/intakes/:intakeId" element={<OnisallPreparation />} /></Routes></MemoryRouter></QueryClientProvider>;
}
async function render(path = `/ONI/onisall/intakes/${ID}`) { await act(async () => { root.render(<Tree path={path} />); }); }
async function wait(assertion: () => void) { await act(async () => { await vi.waitFor(assertion, { timeout: 2000, interval: 10 }); }); }
function button(text: string) { const found = [...container.querySelectorAll("button")].find((element) => element.textContent === text); expect(found, text).toBeDefined(); return found!; }
function panel(title: string) { return [...container.querySelectorAll("section")].find((element) => element.querySelector("h2")?.textContent === title)!; }
async function click(text: string) { await act(async () => { button(text).click(); }); }
async function enter(label: string, value: string) {
  const field = [...container.querySelectorAll("label")].find((element) => element.textContent?.startsWith(label))!.querySelector("input,textarea,select")!;
  await act(async () => {
    const proto = field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : field.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event(field.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function chooseFile(bytes = new Uint8Array([239, 187, 191, 65, 13, 10, 66])) {
  const file = new File([bytes as BlobPart], "source.txt");
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
  const field = container.querySelector('input[type="file"]')!;
  await act(async () => { Object.defineProperty(field, "files", { configurable: true, value: [file] }); field.dispatchEvent(new Event("change", { bubbles: true })); });
}

beforeEach(() => {
  scope.companyId = "company-a"; scope.status = "active"; scope.role = "operator";
  vi.resetAllMocks();
  mocks.get.mockImplementation(async () => draft());
  mocks.preparationStatus.mockImplementation(async () => preparation());
  mocks.nativeRevalidation.mockImplementation(async () => native());
  mocks.preparationBaselineStatus.mockImplementation(async () => baselineStatus());
  mocks.createPreparationBaseline.mockImplementation(async () => ({ baseline: baseline(), replayed: false }));
  mocks.listPipelines.mockResolvedValue([{ id: PIPELINE, companyId: "company-a", name: "Manual", archivedAt: null }]);
  mocks.getPipeline.mockResolvedValue({ stages: [{ id: ID, key: "prepare", name: "Prepare", kind: "working" }] });
  mocks.bindingContext.mockResolvedValue({ protocol: "onisall.binding-context.v1", intakeId: ID, pipelineId: PIPELINE, entryStageKey: "prepare", projectId: null, inputSha256: SHA, configurationHash: SHA, binding: null });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => { await act(async () => { root.unmount(); }); cache.clear(); container.remove(); });

describe("OnisAll preparation workbench", () => {
  it("distinguishes recorded binding, native current version and unavailable execution", async () => {
    await render(); await wait(() => expect(container.textContent).toContain("本次原生准备关系一致"));
    expect(container.textContent).toContain("契约未发布"); expect(container.textContent).toContain("执行未授权");
    expect(panel("输入完整性与准备记录").textContent).toContain("绑定记录存在");
    expect(panel("原生当前版本复验").querySelector("time")?.dateTime).toBe(AT);
    expect(mocks.nativeRevalidation.mock.calls[0][0]).toBe("company-a");
  });
  it("shows retired/archived and configuration blockers from the actual native response", async () => {
    const value = native(); if (value.native.status !== "pending") { value.native.status = "blocked"; value.native.blockers = ["pipeline_archived", "case_retired", "preparation_configuration_changed"]; value.native.configuration.status = "changed"; }
    mocks.nativeRevalidation.mockResolvedValue(value); await render();
    await wait(() => expect(container.textContent).toContain("Pipeline 已归档"));
    expect(container.textContent).toContain("Case 已退役"); expect(container.textContent).toContain("准备配置已变更");
    expect(container.textContent).not.toContain("本次原生准备关系一致");
  });
  it("hides a previous successful observation after revalidation fails", async () => {
    await render(); await wait(() => expect(container.textContent).toContain("本次原生准备关系一致"));
    mocks.nativeRevalidation.mockRejectedValueOnce(new ApiError("integrity", 409, null));
    await click("重新复验原生状态"); await wait(() => expect(panel("原生当前版本复验").querySelector('[role="alert"]')).not.toBeNull());
    expect(panel("原生当前版本复验").textContent).not.toContain("本次原生准备关系一致");
  });
  it.each(["viewer", "paused", "archived"])("keeps %s context read-only while allowing history reads", async (mode) => {
    if (mode === "viewer") scope.role = mode; else scope.status = mode;
    await render(); await wait(() => expect(container.textContent).toContain("本次原生准备关系一致"));
    expect(button("保存准备基线").disabled).toBe(true); expect(mocks.createPreparationBaseline).not.toHaveBeenCalled();
  });
  it("uses byte-exact file content and keeps the logical request key on a failed save retry", async () => {
    mocks.create.mockRejectedValue(new TypeError("network unavailable")); await render("/ONI/onisall/intakes");
    await wait(() => expect(container.querySelector('input[type="file"]')?.hasAttribute("disabled")).toBe(false));
    await enter("交付目标", "Prepare a sample"); await chooseFile(); await click("保存输入草稿");
    await wait(() => expect(mocks.create).toHaveBeenCalledTimes(1)); await wait(() => expect(button("保存输入草稿").disabled).toBe(false));
    await click("保存输入草稿"); await wait(() => expect(mocks.create).toHaveBeenCalledTimes(2));
    const first = mocks.create.mock.calls[0][1]; expect(first.contentBase64).toBe("77u/QQ0KQg=="); expect(mocks.create.mock.calls[1][1].requestKey).toBe(first.requestKey);
    expect(localStorage.length).toBe(0);
  });
  it("rejects invalid UTF-8 before starting a write", async () => {
    await render("/ONI/onisall/intakes"); await wait(() => expect(container.querySelector('input[type="file"]')?.hasAttribute("disabled")).toBe(false));
    await enter("交付目标", "Prepare a sample"); await chooseFile(new Uint8Array([255])); await click("保存输入草稿");
    await wait(() => expect(container.textContent).toContain("文件需要严格 UTF-8")); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("ignores a successful but late save navigation after the company changes", async () => {
    let resolve!: (value: { draft: OnisallIntakeDraft }) => void;
    mocks.create.mockReturnValue(new Promise((done) => { resolve = done; }));
    await render("/ONI/onisall/intakes"); await wait(() => expect(container.querySelector('input[type="file"]')?.hasAttribute("disabled")).toBe(false));
    await enter("交付目标", "Company A input"); await chooseFile(); await click("保存输入草稿"); await wait(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    const oldDraft = draft(false); scope.companyId = "company-b"; await render("/ONI/onisall/intakes");
    await act(async () => { resolve({ draft: oldDraft }); });
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/ONI/onisall/intakes");
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  });
  it("does not show company A's delayed native response after company B's draft is hidden", async () => {
    let resolve!: (value: OnisallNativeRevalidation) => void;
    mocks.nativeRevalidation.mockReturnValue(new Promise((done) => { resolve = done; }));
    const old = native(); await render(); await wait(() => expect(mocks.nativeRevalidation).toHaveBeenCalledTimes(1));
    scope.companyId = "company-b"; mocks.get.mockRejectedValue(new ApiError("hidden", 404, null)); await render();
    await wait(() => expect(container.textContent).toContain("在当前公司 / Project 中不可见"));
    await act(async () => { resolve(old); }); expect(container.textContent).not.toContain("本次原生准备关系一致");
  });
  it("uses server context hashes and discards them after a concurrent binding conflict", async () => {
    mocks.get.mockImplementation(async () => draft(false)); mocks.bind.mockRejectedValue(new ApiError("changed", 409, null));
    await render(); await wait(() => expect(panel("准备原生绑定")).toBeDefined());
    await wait(() => expect(container.querySelector('select')?.disabled).toBe(false)); await enter("Pipeline", PIPELINE);
    await wait(() => expect(container.querySelectorAll("select")[1]?.disabled).toBe(false)); await enter("入口 Stage", "prepare"); await click("读取绑定材料");
    await wait(() => expect(button("保存准备绑定").disabled).toBe(false)); await click("保存准备绑定");
    await wait(() => expect(button("保存准备绑定").disabled).toBe(true));
    expect(mocks.bind.mock.calls[0][2]).toEqual({ pipelineId: PIPELINE, entryStageKey: "prepare", projectId: null, inputSha256: SHA, configurationHash: SHA });
  });
  it("compares a baseline with actual workflow changes and preserves failed-write retry keys", async () => {
    const value = baselineStatus(); value.comparison = { status: "changed", changes: ["workflow_changed", "case_head_changed"] };
    mocks.preparationBaselineStatus.mockResolvedValue(value); mocks.createPreparationBaseline.mockRejectedValue(new TypeError("network unavailable"));
    await render(`/ONI/onisall/intakes/${ID}?baseline=${BASELINE}`); await wait(() => expect(container.textContent).toContain("完整 workflow 配置已变更"));
    expect(container.textContent).toContain("Case 当前版本已变更"); await click("保存准备基线"); await wait(() => expect(button("保存准备基线").disabled).toBe(false));
    await click("保存准备基线"); await wait(() => expect(mocks.createPreparationBaseline).toHaveBeenCalledTimes(2));
    expect(mocks.createPreparationBaseline.mock.calls[0][2].requestKey).toBe(mocks.createPreparationBaseline.mock.calls[1][2].requestKey);
  });
  it("shows hidden object errors rather than stale original input metadata", async () => {
    mocks.get.mockRejectedValue(new ApiError("hidden", 404, null)); await render(); await wait(() => expect(container.textContent).toContain("在当前公司 / Project 中不可见"));
    expect(container.textContent).not.toContain("测试输入"); expect(mocks.nativeRevalidation).not.toHaveBeenCalled();
  });
  it("reports a changed compiler profile without claiming recompile or publication", async () => {
    mocks.schemas.mockResolvedValue({ protocol: "onisall.schema-set-status.v1", evaluatedAt: AT, diagnosticsOnly: true, integrity: "verified", set: { id: BASELINE, schemaCount: 2, totalByteSize: 100, manifestSha256: SHA }, currentCompiler: { matchesFrozenProfile: false }, publication: { status: "unavailable", executionAdmission: "not_granted" } });
    await render(); await enter("Schema 集合 ID", BASELINE); await click("核验 Schema 集合"); await wait(() => expect(container.textContent).toContain("当前编译 profile 已变化"));
    expect(container.textContent).toContain("字节核验不等于重新编译通过");
  });
  it("rejects malformed draft IDs without sending an object read", async () => {
    await render("/ONI/onisall/intakes/bad-id"); expect(container.textContent).toContain("草稿 ID 需要完整 UUID"); expect(mocks.get).not.toHaveBeenCalled();
  });
});
