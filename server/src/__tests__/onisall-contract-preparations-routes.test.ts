import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { errorHandler } from "../middleware/error-handler.js";
import { HttpError } from "../errors.js";
const service = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn() }));
vi.mock("../services/onisall/contract-preparations.js", () => ({ onisallContractPreparationService: () => service }));
import { onisallContractPreparationRoutes } from "../routes/onisall-contract-preparations.js";
const company = "a791faae-3f16-40d7-819a-776320a0cad9", intake = "be3fae21-13ea-492a-9256-627eae44ed87", id = "00000000-0000-4000-8000-000000000001";
const base = `/api/companies/${company}/onisall/intakes/${intake}/contract-preparations`;
const board = { type: "board", source: "session", userId: "owner", companyIds: [company] };
function appFor(actor: unknown) {
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
  app.use("/api", onisallContractPreparationRoutes({} as Db, {} as StorageService)); app.use(errorHandler); return app;
}
beforeEach(() => { vi.resetAllMocks(); service.get.mockResolvedValue({ diagnosticsOnly: true, integrity: "verified" }); service.list.mockResolvedValue({ preparations: [], nextOffset: null }); });
describe("Contract preparation read routes with injected actor fixtures", () => {
  it.each([{ type: "none" }, { type: "agent", companyId: company }, { ...board, source: "mcp_oauth" }, { ...board, companyIds: [] }])("rejects unqualified identity", async actor => {
    await request(appFor(actor)).get(base).expect(403); await request(appFor(actor)).get(`${base}/${id}`).expect(403);
    expect(service.list).not.toHaveBeenCalled(); expect(service.get).not.toHaveBeenCalled();
  });
  it("forwards exact company/intake/detail and disables caching", async () => {
    const app = appFor(board), list = await request(app).get(base + "?offset=50").expect(200);
    expect(list.headers["cache-control"]).toBe("no-store"); expect(service.list).toHaveBeenCalledWith(company, intake, 50);
    const detail = await request(app).get(`${base}/${id}`).expect(200);
    expect(detail.headers["cache-control"]).toBe("no-store"); expect(service.get).toHaveBeenCalledWith(company, intake, id);
  });
  it("rejects ID/query injection and provides no write or publish entry", async () => {
    const app = appFor(board);
    for (const suffix of ["?offset=-1", "?offset=01", "?offset=100001", "?approved=true", "?offset=0&offset=50"]) await request(app).get(base + suffix).expect(400);
    await request(app).get(`${base}/bad`).expect(400); await request(app).get(`${base}/${id}?published=true`).expect(400);
    for (const method of ["post", "put", "patch"] as const) await request(app)[method](base).send({ published: true, scope: {} }).expect(404);
    expect(service.get).not.toHaveBeenCalled(); expect(service.list).not.toHaveBeenCalled();
  });
  it.each([404, 409])("preserves domain rejection %i", async status => {
    service.get.mockRejectedValue(new HttpError(status, "Unavailable")); await request(appFor(board)).get(`${base}/${id}`).expect(status);
  });
});
