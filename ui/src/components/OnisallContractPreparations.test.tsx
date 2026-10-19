// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnisallContractPreparationCatalog, OnisallContractPreparationStatus } from "@paperclipai/shared";
import { OnisallContractPreparations } from "./OnisallContractPreparations";
const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock("@/api/onisall-contract-preparations", () => ({ onisallContractPreparationsApi: mocks }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: { issuePrefix: "ONI" } }) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const id = "00000000-0000-4000-8000-000000000001";
let companyId = "company-a", intakeId = "intake-a";
const catalog = (): OnisallContractPreparationCatalog => ({ protocol: "onisall.contract-preparation-catalog.v1", companyId, intakeId,
  evaluatedAt: "2026-10-10T00:00:00Z", preparations: [{ protocol: "onisall.contract-preparation.v1", id, companyId, intakeId,
    baselineId: id, ruleSetId: id, contractId: id, contractRevision: 1, candidateSha256: "a".repeat(64), candidateByteSize: 1024,
    dependenciesSha256: "b".repeat(64), acceptanceCriteriaHash: "c".repeat(64), checkPlanSha256: "d".repeat(64), preflightSha256: "e".repeat(64),
    purpose: "preparation", executionAdmission: "not_granted", createdAt: "2026-10-10T00:00:00Z" }], nextOffset: null });
const status = (): OnisallContractPreparationStatus => ({ protocol: "onisall.contract-preparation-status.v1", evaluatedAt: "2026-10-10T00:00:00Z",
  diagnosticsOnly: true, integrity: "verified", preparation: catalog().preparations[0]!, current: { status: "matches", changes: [] },
  preflight: { status: "verified", maximumChecks: 3, artifactKinds: ["report_json"] }, publication: { status: "unavailable", executionAdmission: "not_granted" },
  qualification: { sandbox: "not_evaluated", businessAcceptance: "not_evaluated", independentReview: "not_evaluated" } });
let container: HTMLDivElement, root: Root, cache: QueryClient;
const render = async (path = "/ONI/onisall/intakes/test") => { await act(async () => root.render(
  <QueryClientProvider client={cache}><MemoryRouter initialEntries={[path]}>
    <OnisallContractPreparations key={`${companyId}:${intakeId}`} companyId={companyId} intakeId={intakeId} />
  </MemoryRouter></QueryClientProvider>)); };
const wait = async (assertion: () => void) => { await act(async () => { await vi.waitFor(assertion, { timeout: 2000, interval: 10 }); }); };
const click = async (text: string) => { await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === text)!.click()); };
beforeEach(() => { vi.resetAllMocks(); companyId = "company-a"; intakeId = "intake-a";
  mocks.list.mockImplementation(async () => catalog()); mocks.get.mockImplementation(async () => status());
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); cache.clear(); container.remove(); });
describe("Stored contract preparation browser", () => {
  it("lists metadata without claiming integrity and checks actual detail on selection", async () => {
    await render(); await wait(() => expect(container.textContent).toContain("核验候选 · 00000000"));
    expect(mocks.get).not.toHaveBeenCalled(); expect(container.textContent).not.toContain("历史候选字节及依赖材料已核验");
    await click("核验候选 · 00000000"); await wait(() => expect(container.textContent).toContain("历史候选字节及依赖材料已核验"));
    expect(mocks.get).toHaveBeenCalledWith("company-a", "intake-a", id, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(container.textContent).toContain("契约未正式发布，执行未授权；业务语义、实际隔离与独立评审尚未验收");
    expect(container.querySelector("a")?.getAttribute("href")).toContain(`/onisall/rules/${id}`);
  });
  it("hides successful detail throughout refresh and after failure", async () => {
    await render(`/?contractPreparation=${id}`); await wait(() => expect(container.textContent).toContain("完整离线预检已重新计算"));
    let reject!: (error: Error) => void; mocks.get.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    await click("重新复验候选"); await wait(() => expect(container.textContent).toContain("正在回读实际输入和规则材料"));
    expect(container.textContent).not.toContain("历史候选字节及依赖材料已核验");
    await act(async () => reject(new Error("failure"))); await wait(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.textContent).not.toContain("完整离线预检已重新计算");
  });
  it("ignores late success after company and intake switch", async () => {
    let resolve!: (value: OnisallContractPreparationStatus) => void; const old = status();
    mocks.get.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await render(`/?contractPreparation=${id}`); await wait(() => expect(mocks.get).toHaveBeenCalledTimes(1));
    companyId = "company-b"; intakeId = "intake-b"; mocks.get.mockRejectedValue(new Error("foreign")); await render();
    await act(async () => resolve(old)); await wait(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.textContent).not.toContain("历史候选字节及依赖材料已核验");
    expect(mocks.get).toHaveBeenLastCalledWith("company-b", "intake-b", id, expect.anything());
  });
  it("shows drift independently of intact history and avoids claiming current preflight on profile drift", async () => {
    const value = status(); value.current = { status: "changed", changes: ["workflow_changed", "compiler_profile_changed"] }; value.preflight.status = "profile_changed";
    mocks.get.mockResolvedValue(value); await render(`/?contractPreparation=${id}`);
    await wait(() => expect(container.textContent).toContain("历史候选未自动升级"));
    expect(container.textContent).toContain("历史候选字节及依赖材料已核验"); expect(container.textContent).not.toContain("完整离线预检已重新计算");
    expect(container.textContent).toContain("候选基线与当前状态存在变化");
  });
  it("rejects invalid candidate links before detail reads", async () => {
    await render("/?contractPreparation=forged"); expect(container.textContent).toContain("候选 ID 无效"); expect(mocks.get).not.toHaveBeenCalled();
  });
  it("pages bounded metadata and resets scope pagination", async () => {
    mocks.list.mockResolvedValue({ ...catalog(), nextOffset: 50 }); await render();
    await wait(() => expect(container.textContent).toContain("核验候选 · 00000000")); await click("下一页候选");
    await wait(() => expect(mocks.list).toHaveBeenCalledWith("company-a", "intake-a", 50, expect.anything()));
    companyId = "company-b"; await render(); await wait(() => expect(mocks.list).toHaveBeenCalledWith("company-b", "intake-a", 0, expect.anything()));
  });
  it("shows empty history without a candidate upload or publication action", async () => {
    mocks.list.mockResolvedValue({ ...catalog(), preparations: [] }); await render();
    await wait(() => expect(container.textContent).toContain("此输入尚无契约候选"));
    expect(container.querySelector('input[type="file"]')).toBeNull(); expect(mocks.get).not.toHaveBeenCalled();
  });
});
