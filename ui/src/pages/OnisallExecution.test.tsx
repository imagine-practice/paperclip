// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ONISALL_EXECUTION_TEST_MODEL, ONISALL_EXECUTION_TEST_PROMPT, type OnisallExecutionTests } from "@paperclipai/shared";
import { OnisallExecution } from "./OnisallExecution";
const scope = vi.hoisted(() => ({ companyId: "company-a", status: "active", role: "operator" }));
const mocks = vi.hoisted(() => ({ list: vi.fn(), evaluate: vi.fn(), invoke: vi.fn(), cancel: vi.fn() }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: scope.companyId, selectedCompany: { status: scope.status, issuePrefix: "ONI" } }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => undefined }) }));
vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: async () => ({ source: "session", keyId: null, memberships: [{ companyId: scope.companyId, status: "active", membershipRole: scope.role }] }) } }));
vi.mock("@/api/onisall-execution-tests", () => ({ onisallExecutionTestsApi: { ...mocks, evidencePath: (company: string, run: string) => `/api/${company}/${run}/evidence` } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { cancel: mocks.cancel } }));
const list = (run = false): OnisallExecutionTests => ({ protocol: "onisall.execution-tests.v1", companyId: scope.companyId,
  evaluatedAt: "2026-10-10T00:00:00Z", model: ONISALL_EXECUTION_TEST_MODEL, prompt: ONISALL_EXECUTION_TEST_PROMPT,
  maxRunsPerAgent: 4, maxTurns: 1, timeoutSec: 120, slots: [{ agentId: "agent-a", issueId: "issue-a", identifier: "ONI-99", title: "Sample",
    available: !run, blockers: run ? ["single_use_dispatched"] : [], run: run ? { id: "run-a", status: "succeeded", startedAt: null, finishedAt: null } : null }] });
let container: HTMLDivElement, root: Root, cache: QueryClient;
const tree = () => <QueryClientProvider client={cache}><MemoryRouter initialEntries={["/ONI/onisall/execution"]}><OnisallExecution /></MemoryRouter></QueryClientProvider>;
const render = async () => { await act(async () => { root.render(tree()); }); };
const wait = async (assertion: () => void) => { await act(async () => { await vi.waitFor(assertion, { timeout: 2000, interval: 10 }); }); };
function button(text: string) { return [...container.querySelectorAll("button")].find(node => node.textContent === text)!; }
const click = async (text: string) => { await act(async () => { button(text).click(); }); };
beforeEach(() => {
  vi.resetAllMocks(); scope.companyId = "company-a"; scope.status = "active"; scope.role = "operator";
  mocks.list.mockImplementation(async () => list()); mocks.invoke.mockResolvedValue({ id: "run-a", status: "queued" });
  mocks.evaluate.mockResolvedValue({ run: { id: "run-a", status: "succeeded" }, verdict: "pass", output: "REAL_OUTPUT", checks: [{ code: "exact_output", status: "pass" }],
    inputTokens: null, outputTokens: 12, cliReportedModels: [], evaluatedAt: "2026-10-10T00:00:00Z" });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => { await act(async () => { root.unmount(); }); cache.clear(); container.remove(); });
describe("model execution workbench", () => {
  it("displays the actual fixed prompt and unknown business acceptance, without starting a Run", async () => {
    await render(); await wait(() => expect(button("执行 ONI-99")).toBeDefined());
    expect(container.textContent).toContain(ONISALL_EXECUTION_TEST_PROMPT); expect(container.textContent).toContain("费用未定价");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("starts once despite rapid double click and reads native results", async () => {
    let resolve!: (value: object) => void; mocks.invoke.mockReturnValue(new Promise(done => { resolve = done; }));
    await render(); await wait(() => expect(button("执行 ONI-99").disabled).toBe(false));
    await act(async () => { button("执行 ONI-99").click(); button("执行 ONI-99").click(); });
    expect(mocks.invoke).toHaveBeenCalledTimes(1); expect(mocks.invoke).toHaveBeenCalledWith("company-a", "agent-a", "issue-a");
    mocks.list.mockResolvedValue(list(true)); await act(async () => { resolve({ id: "run-a" }); });
    await wait(() => expect(container.textContent).toContain("REAL_OUTPUT"));
    expect(container.textContent).toContain("业务语义验收：未评估"); expect(container.querySelector('a[download]')?.getAttribute("href")).toContain("company-a/run-a/evidence");
  });
  it("does not repeat an unknown write, even after refreshing a slot with no visible Run", async () => {
    mocks.invoke.mockRejectedValue(new Error("network")); await render(); await wait(() => expect(button("执行 ONI-99").disabled).toBe(false));
    await click("执行 ONI-99"); await wait(() => expect(container.textContent).toContain("不要重复执行"));
    await click("刷新任务与 Run"); await wait(() => expect(button("执行 ONI-99").disabled).toBe(true));
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
  it.each(["viewer", "paused"])("disables execution for %s", async value => {
    if (value === "viewer") scope.role = value; else scope.status = value;
    await render(); await wait(() => expect(button("执行 ONI-99")).toBeDefined());
    expect(button("执行 ONI-99").disabled).toBe(true); expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("hides an old successful evaluation when refresh fails", async () => {
    mocks.list.mockResolvedValue(list(true)); await render(); await wait(() => expect(button("查看 ONI-99 结果")).toBeDefined());
    await click("查看 ONI-99 结果"); await wait(() => expect(container.textContent).toContain("REAL_OUTPUT"));
    mocks.evaluate.mockRejectedValue(new Error("revoked")); await click("重新读取检查结果");
    await wait(() => expect(container.textContent).toContain("读取失败")); expect(container.textContent).not.toContain("REAL_OUTPUT");
  });
  it("ignores a late write response after switching company", async () => {
    let resolve!: (value: object) => void; mocks.invoke.mockReturnValue(new Promise(done => { resolve = done; }));
    await render(); await wait(() => expect(button("执行 ONI-99").disabled).toBe(false)); await click("执行 ONI-99");
    scope.companyId = "company-b"; mocks.list.mockResolvedValue({ ...list(), slots: [] }); await render();
    await act(async () => { resolve({ id: "run-a" }); });
    await wait(() => expect(container.textContent).toContain("没有已配置")); expect(container.textContent).not.toContain("已发起原生 Run");
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
});
