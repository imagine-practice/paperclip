import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { Writable } from "node:stream";
import pino from "pino";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createHttpLogger } from "../middleware/logger.js";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";
import { HttpError } from "../errors.js";

const svc = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), observe: vi.fn(), observations: vi.fn(), content: vi.fn(), preparationStatus: vi.fn(), nativeRevalidation: vi.fn() }));
const binding = vi.hoisted(() => ({ context: vi.fn(), get: vi.fn(), bind: vi.fn() }));
vi.mock("../services/onisall/native-bindings.js", () => ({ onisallNativeBindingService: () => binding }));
vi.mock("../services/onisall/intake-drafts.js", () => ({ onisallIntakeDraftService: () => svc }));
import { onisallIntakeRoutes } from "../routes/onisall-intakes.js";

const company = "a791faae-3f16-40d7-819a-776320a0cad9";
const id = "be3fae21-13ea-492a-9256-627eae44ed87";
const base = `/api/companies/${company}/onisall/intakes`;
const board = { type: "board", source: "session", userId: "operator", companyIds: [company],
  memberships: [{ companyId: company, status: "active", membershipRole: "owner" }] };
const input = { requestKey: "draft-1", goal: "prepare", sourceLabel: "private source", contentBase64: "YQ==" };
function appFor(actor: unknown, chunks?: string[]) {
  const app = express();
  if (chunks) app.use(createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] },
    new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } }))));
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
  app.use("/api", onisallIntakeRoutes({} as Db, {} as StorageService));
  app.use(errorHandler);
  return app;
}
beforeEach(() => {
  vi.resetAllMocks();
  svc.get.mockResolvedValue({ id });
  svc.preparationStatus.mockResolvedValue({ intakeId: id, diagnosticsOnly: true });
  svc.nativeRevalidation.mockResolvedValue({ intakeId: id, diagnosticsOnly: true });
  binding.get.mockResolvedValue({ binding: null });
  binding.bind.mockResolvedValue({ binding: { id }, replayed: false });
  binding.context.mockResolvedValue({ intakeId: id });
  svc.create.mockResolvedValue({ draft: { id }, replayed: false });
  svc.observations.mockResolvedValue({ observations: [], nextOffset: null });
  svc.content.mockResolvedValue({ bytes: Buffer.from("a"), sha256: "a".repeat(64) });
});

describe.each(["preparation-status", "native-revalidation"])("OnisAll %s route (injected actors)", endpoint => {
  const read = () => endpoint === "preparation-status" ? svc.preparationStatus : svc.nativeRevalidation;
  it.each([{ type: "none" }, { type: "agent", companyId: company, agentId: id },
    { ...board, source: "mcp_oauth" }, { ...board, companyIds: [] }])("rejects unauthorized status reads", async actor => {
    await request(appFor(actor)).get(`${base}/${id}/${endpoint}`).expect(403);
    expect(read()).not.toHaveBeenCalled();
  });
  it("allows a viewer read with no-store and exact company/intake scope", async () => {
    const viewer = { ...board, memberships: [{ companyId: company, status: "active", membershipRole: "viewer" }] };
    const result = await request(appFor(viewer)).get(`${base}/${id}/${endpoint}`).expect(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(read()).toHaveBeenCalledWith(company, id);
    expect(svc.create).not.toHaveBeenCalled(); expect(binding.bind).not.toHaveBeenCalled();
  });
  it("rejects caller-supplied verdicts and malformed IDs", async () => {
    await request(appFor(board)).get(`${base}/${id}/${endpoint}?approved=true`).expect(400);
    await request(appFor(board)).get(`${base}/bad/${endpoint}`).expect(400);
    expect(read()).not.toHaveBeenCalled();
  });
  it.each([404, 409, 503])("preserves a failed diagnostic as HTTP %i", async status => {
    read().mockRejectedValue(new HttpError(status, "Unavailable"));
    await request(appFor(board)).get(`${base}/${id}/${endpoint}`).expect(status);
  });
});
describe("OnisAll route authority (injected actor fixtures, not login proof)", () => {
  it.each([{ type: "none" }, { type: "agent", companyId: company, agentId: id },
    { ...board, source: "mcp_oauth" }, { ...board, companyIds: [] }])("rejects unauthorised actors before service access", async (actor) => {
    const app = appFor(actor);
    await request(app).get(`${base}/${id}`).expect(403);
    await request(app).post(base).send(input).expect(403);
    expect(svc.get).not.toHaveBeenCalled(); expect(svc.create).not.toHaveBeenCalled();
  });
  it("allows viewer reads and rejects writes", async () => {
    const app = appFor({ ...board, memberships: [{ companyId: company, status: "active", membershipRole: "viewer" }] });
    await request(app).get(`${base}/${id}`).expect(200);
    await request(app).post(base).send(input).expect(403);
    expect(svc.create).not.toHaveBeenCalled();
  });
  it("passes the exact company and actor, and distinguishes replay", async () => {
    const app = appFor(board);
    await request(app).post(base).send(input).expect(201);
    expect(svc.create).toHaveBeenCalledWith(company, "operator", input);
    svc.create.mockResolvedValue({ draft: { id }, replayed: true });
    await request(app).post(base).send(input).expect(200);
  });
  it("rejects authority injection and malformed pagination before service", async () => {
    const app = appFor(board);
    await request(app).post(base).send({ ...input, status: "published" }).expect(400);
    await request(app).get(`${base}/${id}/observations?offset=-1`).expect(400);
    expect(svc.create).not.toHaveBeenCalled(); expect(svc.observations).not.toHaveBeenCalled();
  });
  it("downloads as non-cacheable non-sniffable attachment", async () => {
    const response = await request(appFor(board)).get(`${base}/${id}/content`).expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-disposition"]).toContain("attachment");
  });
});
describe("OnisAll HTTP input privacy", () => {
  it.each([400, 403, 409, 503])("omits raw input and provider prose in %i diagnostic logs", async (status) => {
    const chunks: string[] = [];
    const canary = "private-input-canary-82753";
    const encoded = Buffer.from(canary).toString("base64");
    svc.create.mockRejectedValue(new HttpError(status, `driver echoed ${canary}`));
    await request(appFor(board, chunks)).post(`/API/COMPANIES/${company}/ONISALL/INTAKES`)
      .send({ ...input, goal: canary, sourceLabel: canary, contentBase64: encoded }).expect(status);
    const output = chunks.join("");
    expect(output).not.toContain(canary); expect(output).not.toContain(encoded);
    const log = JSON.parse(output.trim());
    expect(log.reqBody).toBe("[REDACTED]"); expect(log.req.body).toBeUndefined();
    expect(log.reqParams).toBeUndefined(); expect(log.res.headers).toBeUndefined();
  });
});


describe("OnisAll preparation binding routes", () => {
  const input = { pipelineId: id, projectId: null, entryStageKey: "intake", inputSha256: "a".repeat(64), configurationHash: "b".repeat(64) };
  it("validates the context and strict binding payload, and preserves replay status", async () => {
    const app = appFor(board);
    await request(app).get(`${base}/${id}/binding-context`).query({ pipelineId: id, entryStageKey: "intake" }).expect(200);
    expect(binding.context).toHaveBeenCalledWith(company, id, { pipelineId: id, entryStageKey: "intake" });
    await request(app).post(`${base}/${id}/binding`).send({ ...input, caseId: id }).expect(400);
    expect(binding.bind).not.toHaveBeenCalled();
    await request(app).post(`${base}/${id}/binding`).send(input).expect(201);
    expect(binding.bind).toHaveBeenCalledWith(company, id, input);
    binding.bind.mockResolvedValue({ binding: { id }, replayed: true });
    await request(app).post(`${base}/${id}/binding`).send(input).expect(200);
    await request(app).get(`${base}/${id}/binding`).expect(200);
    await request(app).get(`${base}/${id}/binding-context`).query({ pipelineId: "bad", entryStageKey: "intake" }).expect(400);
  });
  it.each([{ type: "none" }, { type: "agent", companyId: company, agentId: id },
    { ...board, source: "mcp_oauth" }, { ...board, companyIds: [] }])("denies untrusted binding access", async denied => {
    await request(appFor(denied)).post(`${base}/${id}/binding`).send(input).expect(403);
    await request(appFor(denied)).get(`${base}/${id}/binding`).expect(403);
    expect(binding.bind).not.toHaveBeenCalled(); expect(binding.get).not.toHaveBeenCalled();
  });
  it("allows a viewer read while denying binding mutations", async () => {
    const app = appFor({ ...board, memberships: [{ companyId: company, status: "active", membershipRole: "viewer" }] });
    await request(app).get(`${base}/${id}/binding`).expect(200);
    await request(app).post(`${base}/${id}/binding`).send(input).expect(403);
    expect(binding.bind).not.toHaveBeenCalled();
  });
});
