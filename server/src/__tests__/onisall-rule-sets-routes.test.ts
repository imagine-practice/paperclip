import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { errorHandler } from "../middleware/error-handler.js";
import { HttpError } from "../errors.js";
const service = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn() }));
vi.mock("../services/onisall/frozen-rule-sets.js", () => ({ onisallFrozenRuleSetService: () => service }));
import { onisallRuleSetRoutes } from "../routes/onisall-rule-sets.js";
const company = "a791faae-3f16-40d7-819a-776320a0cad9", id = "be3fae21-13ea-492a-9256-627eae44ed87";
const base = `/api/companies/${company}/onisall/rule-sets`;
const board = { type: "board", source: "session", userId: "operator", companyIds: [company] };
function appFor(actor: unknown) {
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
  app.use("/api", onisallRuleSetRoutes({} as Db, {} as StorageService)); app.use(errorHandler); return app;
}
beforeEach(() => { vi.resetAllMocks(); service.get.mockResolvedValue({ integrity: "verified", diagnosticsOnly: true }); service.list.mockResolvedValue({ sets: [], nextOffset: null }); });
describe("Execution rule read routes: injected actors only", () => {
  it.each([{ type: "none" }, { type: "agent", companyId: company }, { ...board, source: "mcp_oauth" }, { ...board, companyIds: [] }])("rejects unqualified callers", async actor => {
    await request(appFor(actor)).get(base).expect(403); await request(appFor(actor)).get(`${base}/${id}`).expect(403);
    expect(service.list).not.toHaveBeenCalled(); expect(service.get).not.toHaveBeenCalled();
  });
  it("reads exact company/list/detail with no-store", async () => {
    const app = appFor(board); const list = await request(app).get(base + "?offset=50").expect(200);
    expect(list.headers["cache-control"]).toBe("no-store"); expect(service.list).toHaveBeenCalledWith(company, 50);
    const detail = await request(app).get(`${base}/${id}`).expect(200); expect(detail.headers["cache-control"]).toBe("no-store");
    expect(service.get).toHaveBeenCalledWith(company, id);
  });
  it("rejects malformed IDs, verdict injection and invalid/broad queries", async () => {
    const app = appFor(board);
    for (const suffix of ["?offset=-1", "?offset=01", "?offset=100001", "?approved=true", "?offset=0&offset=50"]) await request(app).get(base + suffix).expect(400);
    await request(app).get(`${base}/bad`).expect(400); await request(app).get(`${base}/${id}?approved=true`).expect(400);
    expect(service.get).not.toHaveBeenCalled(); expect(service.list).not.toHaveBeenCalled();
  });
  it("does not expose any mutation or asset registration", async () => {
    await request(appFor(board)).post(base).send({ bytes: "ignored" }).expect(404);
    await request(appFor(board)).put(`${base}/${id}`).send({ granted: true }).expect(404);
  });
  it.each([404, 409])("preserves domain rejection %i", async status => {
    service.get.mockRejectedValue(new HttpError(status, "Unavailable")); await request(appFor(board)).get(`${base}/${id}`).expect(status);
  });
});
