import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { createOnisallIntakeDraftSchema, observeOnisallInputSchema } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { forbidden, unauthorized } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { onisallIntakeDraftService } from "../services/onisall/intake-drafts.js";

export function onisallIntakeRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const svc = onisallIntakeDraftService(db, storage);
  const base = "/companies/:companyId/onisall/intakes";
  router.use(base, (req, res, next) => {
    assertBoard(req);
    // No capability mapping for delegated MCP board credentials exists yet.
    if (req.actor.source === "mcp_oauth") throw forbidden("Direct board session required");
    const companyId = z.string().uuid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    if (!req.actor.userId) throw unauthorized();
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.post(base, validate(createOnisallIntakeDraftSchema), async (req, res) => {
    const result = await svc.create(req.params.companyId as string, req.actor.userId!, req.body);
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.get(`${base}/:id`, async (req, res) => {
    res.json(await svc.get(req.params.companyId as string, z.string().uuid().parse(req.params.id)));
  });
  router.get(`${base}/:id/content`, async (req, res) => {
    const result = await svc.content(req.params.companyId as string, z.string().uuid().parse(req.params.id));
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", 'attachment; filename="input.txt"');
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Onisall-Input-Sha256", result.sha256);
    res.send(result.bytes);
  });
  router.post(`${base}/:id/observations`, validate(observeOnisallInputSchema), async (req, res) => {
    const result = await svc.observe(req.params.companyId as string, z.string().uuid().parse(req.params.id), req.actor.userId!, req.body);
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.get(`${base}/:id/observations`, async (req, res) => {
    const offset = z.coerce.number().int().min(0).max(1_000_000).parse(req.query.offset ?? 0);
    res.json(await svc.observations(req.params.companyId as string, z.string().uuid().parse(req.params.id), offset));
  });
  return router;
}
