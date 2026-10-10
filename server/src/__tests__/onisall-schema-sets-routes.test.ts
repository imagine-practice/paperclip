import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { HttpError } from "../errors.js";

const service = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../services/onisall/frozen-schema-sets.js", () => ({ onisallFrozenSchemaSetService: () => service }));
import { onisallSchemaSetRoutes } from "../routes/onisall-schema-sets.js";
const company = "a791faae-3f16-40d7-819a-776320a0cad9", id = "be3fae21-13ea-492a-9256-627eae44ed87";
const base = `/api/companies/${company}/onisall/schema-sets`;
const board = { type: "board", source: "session", userId: "operator", companyIds: [company],
  memberships: [{ companyId: company, status: "active", membershipRole: "owner" }] };
function appFor(actor: unknown) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
  app.use("/api", onisallSchemaSetRoutes({} as Db)); app.use(errorHandler); return app;
}
beforeEach(() => { vi.resetAllMocks(); service.get.mockResolvedValue({ diagnosticsOnly: true, integrity: "verified" }); });
describe("Schema set read routes (injected actor fixtures)", () => {
  it.each([{ type: "none" }, { type: "agent", companyId: company }, { ...board, source: "mcp_oauth" }, { ...board, companyIds: [] }])("rejects unauthorized readers", async actor => {
    await request(appFor(actor)).get(`${base}/${id}`).expect(403); expect(service.get).not.toHaveBeenCalled();
  });
  it("allows company viewers with no-store and exact scope", async () => {
    const app = appFor({ ...board, memberships: [{ companyId: company, status: "active", membershipRole: "viewer" }] });
    const result = await request(app).get(`${base}/${id}`).expect(200);
    expect(result.headers["cache-control"]).toBe("no-store"); expect(service.get).toHaveBeenCalledWith(company, id);
  });
  it("does not register a model/HTTP schema upload or freeze endpoint", async () => {
    await request(appFor(board)).post(base).send({ schema: { type: "object" } }).expect(404);
    await request(appFor(board)).post(`${base}/${id}`).send({ approved: true }).expect(404);
    expect(service.get).not.toHaveBeenCalled();
  });
  it("rejects malformed IDs and caller-supplied diagnostic verdicts", async () => {
    const app = appFor(board);
    await request(app).get(`${base}/bad`).expect(400); await request(app).get(`${base}/${id}?approved=true`).expect(400);
    expect(service.get).not.toHaveBeenCalled();
  });
  it.each([404, 409])("preserves error HTTP %i without returning verified", async status => {
    service.get.mockRejectedValue(new HttpError(status, "Unavailable")); await request(appFor(board)).get(`${base}/${id}`).expect(status);
  });
});
