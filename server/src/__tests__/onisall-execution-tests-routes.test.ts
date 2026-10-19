import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
const svc = vi.hoisted(() => ({ list: vi.fn(), evaluate: vi.fn() }));
vi.mock("../services/onisall/execution-tests.js", () => ({ onisallExecutionTestService: () => svc }));
import { onisallExecutionTestRoutes } from "../routes/onisall-execution-tests.js";
const company = "00000000-0000-4000-8000-000000000001", run = "00000000-0000-4000-8000-000000000002";
const board = { type: "board", source: "session", userId: "owner", companyIds: [company] };
function appFor(actor: unknown = board) {
  const app = express(); app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
  app.use("/api", onisallExecutionTestRoutes({} as Db)); app.use(errorHandler); return app;
}
const base = `/api/companies/${company}/onisall/execution-tests`;
beforeEach(() => { vi.resetAllMocks(); svc.list.mockResolvedValue({ slots: [] }); svc.evaluate.mockResolvedValue({ verdict: "pass", executionGrant: "not_granted" }); });
describe("execution test route boundary", () => {
  it("returns no-store lists and derives a downloadable server evaluation", async () => {
    expect((await request(appFor()).get(base)).headers["cache-control"]).toBe("no-store");
    const evidence = await request(appFor()).get(`${base}/runs/${run}/evidence`);
    expect(evidence.status).toBe(200); expect(evidence.headers["content-disposition"]).toContain("attachment");
    expect(evidence.body.executionGrant).toBe("not_granted"); expect(svc.evaluate).toHaveBeenCalledWith(company, run);
  });
  it.each([{ type: "agent", companyId: company }, { ...board, source: "mcp_oauth" }, { ...board, companyIds: [] }])("rejects unavailable actor %j before service use", async actor => {
    expect((await request(appFor(actor)).get(base)).status).toBe(403); expect(svc.list).not.toHaveBeenCalled();
  });
  it("rejects client predicates and invalid IDs rather than accepting a verdict", async () => {
    expect((await request(appFor()).get(base + "?verdict=pass")).status).toBe(400);
    expect((await request(appFor()).get(`${base}/runs/bad/evaluation`)).status).toBe(400);
    expect(svc.evaluate).not.toHaveBeenCalled();
  });
});
