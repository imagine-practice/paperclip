// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnisallRuleSetCatalog, OnisallFrozenRuleSetStatus } from "@paperclipai/shared";
import { OnisallRules } from "./OnisallRules";
const scope = vi.hoisted(() => ({ companyId: "company-a" }));
const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: scope.companyId, selectedCompany: { issuePrefix: "ONI" } }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => undefined }) }));
vi.mock("@/api/onisall-rule-sets", () => ({ onisallRuleSetsApi: mocks }));
const id = "00000000-0000-4000-8000-000000000001";
const catalog = (): OnisallRuleSetCatalog => ({ protocol: "onisall.rule-set-catalog.v1", companyId: scope.companyId,
  evaluatedAt: "2026-10-10T00:00:00Z", sets: [{ id, schemaSetId: "schema-a", manifestSha256: "a".repeat(64), assetCount: 4,
    totalByteSize: 128, purpose: "preparation", executionAdmission: "not_granted", createdAt: "2026-10-10T00:00:00Z" }], nextOffset: null });
const status = (): OnisallFrozenRuleSetStatus => ({ protocol: "onisall.rule-set-status.v1", evaluatedAt: "2026-10-10T00:00:00Z", diagnosticsOnly: true,
  integrity: "verified", set: { ...catalog().sets[0]!, protocol: "onisall.persisted-rule-set.v1", companyId: scope.companyId,
    assets: [{ kind: "check", registryKey: "W1-C01-traceability", revision: "1", sha256: "b".repeat(64), byteSize: 32,
      check: { targetKinds: ["artifact", "source"], evidenceMode: "machine" } }] },
  preparation: { registry: "verified", schemaCompilerMatches: true, schemaCompilation: "verified" },
  publication: { status: "unavailable", executionAdmission: "not_granted" }, qualification: { sandbox: "not_evaluated", businessAcceptance: "not_evaluated" } });
let container: HTMLDivElement, root: Root, cache: QueryClient;
const tree = (path: string) => <QueryClientProvider client={cache}><MemoryRouter initialEntries={[path]}><Routes>
  <Route path="/ONI/onisall/rules" element={<OnisallRules />} /><Route path="/ONI/onisall/rules/:ruleSetId" element={<OnisallRules />} />
</Routes></MemoryRouter></QueryClientProvider>;
const render = async (path = "/ONI/onisall/rules") => { await act(async () => { root.render(tree(path)); }); };
const wait = async (assertion: () => void) => { await act(async () => { await vi.waitFor(assertion, { timeout: 2000, interval: 10 }); }); };
const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent === text)!;
const click = async (text: string) => { await act(async () => { button(text).click(); }); };
beforeEach(() => {
  vi.resetAllMocks(); scope.companyId = "company-a"; mocks.list.mockImplementation(async () => catalog()); mocks.get.mockImplementation(async () => status());
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); cache.clear(); container.remove(); });
describe("Execution rule material browser", () => {
  it("opens stored rules without UUID copying and reads actual detail only on navigation", async () => {
    await render(); await wait(() => expect(container.textContent).toContain("打开规则集合 · 4 件资产"));
    expect(mocks.get).not.toHaveBeenCalled();
    const link = [...container.querySelectorAll("a")].find(a => a.textContent?.startsWith("打开规则集合"))!;
    expect(link.getAttribute("href")).toBe(`/ONI/onisall/rules/${id}`); await act(async () => link.click());
    await wait(() => expect(container.textContent).toContain("W1-C01-traceability"));
    expect(mocks.get).toHaveBeenCalledWith("company-a", id, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(container.textContent).toContain("业务语义验收及实际隔离尚未评估");
    expect(container.textContent).toContain("来源追溯检查只能证明引用与覆盖");
  });
  it("hides old successful detail during a failed refresh", async () => {
    await render(`/ONI/onisall/rules/${id}`); await wait(() => expect(container.textContent).toContain("W1-C01-traceability"));
    mocks.get.mockRejectedValue(new Error("unavailable")); await click("重新核验规则字节");
    await wait(() => expect(container.querySelector('[role="alert"]')).not.toBeNull()); expect(container.textContent).not.toContain("registry 已核验");
    expect(container.textContent).not.toContain("W1-C01-traceability");
  });
  it("ignores a late detail response after company switch", async () => {
    let resolve!: (value: OnisallFrozenRuleSetStatus) => void; mocks.get.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await render(`/ONI/onisall/rules/${id}`); await wait(() => expect(mocks.get).toHaveBeenCalledTimes(1));
    const old = status(); scope.companyId = "company-b"; mocks.get.mockRejectedValue(new Error("foreign")); await render(`/ONI/onisall/rules/${id}`);
    await act(async () => resolve(old)); await wait(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.textContent).not.toContain("W1-C01-traceability");
  });
  it("displays actual compiler drift without upgrading historical materials", async () => {
    const value = status(); value.preparation = { registry: "verified", schemaCompilerMatches: false, schemaCompilation: "profile_changed" }; mocks.get.mockResolvedValue(value);
    await render(`/ONI/onisall/rules/${id}`); await wait(() => expect(container.textContent).toContain("Schema 编译 profile 已变化"));
    expect(container.textContent).not.toContain("关联 Schema 已按当前编译器重新编译");
    expect(container.textContent).toContain("执行未授权");
  });
  it("shows an empty company directory without suggesting rule uploads", async () => {
    mocks.list.mockResolvedValue({ ...catalog(), sets: [] }); await render();
    await wait(() => expect(container.textContent).toContain("当前公司尚无规则集合")); expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it("pages bounded historical records and resets the catalog on company switch", async () => {
    mocks.list.mockResolvedValue({ ...catalog(), nextOffset: 50 }); await render(); await wait(() => expect(button("下一页").disabled).toBe(false));
    await click("下一页"); await wait(() => expect(mocks.list).toHaveBeenCalledWith("company-a", 50, expect.anything()));
    scope.companyId = "company-b"; await render(); await wait(() => expect(mocks.list).toHaveBeenCalledWith("company-b", 0, expect.anything()));
  });
  it("rejects malformed direct links before API calls", async () => {
    await render("/ONI/onisall/rules/invalid"); expect(container.textContent).toContain("规则集合 ID 无效");
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled();
  });
});
