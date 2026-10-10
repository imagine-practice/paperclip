import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { createOnisallIntakeDraftSchema, observeOnisallInputSchema, createOnisallBindingSchema, onisallBindingContextSchema } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { forbidden, unauthorized } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { onisallNativeBindingService } from "../services/onisall/native-bindings.js";
import { onisallIntakeDraftService } from "../services/onisall/intake-drafts.js";

export function onisallIntakeRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const svc = (req: Request) => onisallIntakeDraftService(db, storage, req.actor);
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
    const result = await svc(req).create(req.params.companyId as string, req.actor.userId!, req.body);
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.get(`${base}/:id`, async (req, res) => {
    res.json(await svc(req).get(req.params.companyId as string, z.string().uuid().parse(req.params.id)));
  });
  router.get(`${base}/:id/content`, async (req, res) => {
    const result = await svc(req).content(req.params.companyId as string, z.string().uuid().parse(req.params.id));
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", 'attachment; filename="input.txt"');
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Onisall-Input-Sha256", result.sha256);
    res.send(result.bytes);
  });
  router.post(`${base}/:id/observations`, validate(observeOnisallInputSchema), async (req, res) => {
    const result = await svc(req).observe(req.params.companyId as string, z.string().uuid().parse(req.params.id), req.actor.userId!, req.body);
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.get(`${base}/:id/observations`, async (req, res) => {
    const offset = z.coerce.number().int().min(0).max(1_000_000).parse(req.query.offset ?? 0);
    res.json(await svc(req).observations(req.params.companyId as string, z.string().uuid().parse(req.params.id), offset));
  });
  router.get(`${base}/:id/binding-context`, async (req, res) => {
    const input = onisallBindingContextSchema.parse(req.query);
    res.json(await onisallNativeBindingService(db, storage, req.actor).context(
      req.params.companyId as string, z.string().uuid().parse(req.params.id), input));
  });
  router.get(`${base}/:id/binding`, async (req, res) => {
    res.json(await onisallNativeBindingService(db, storage, req.actor).get(
      req.params.companyId as string, z.string().uuid().parse(req.params.id)));
  });
  router.post(`${base}/:id/binding`, validate(createOnisallBindingSchema), async (req, res) => {
    const result = await onisallNativeBindingService(db, storage, req.actor).bind(
      req.params.companyId as string, z.string().uuid().parse(req.params.id), req.body);
    res.status(result.replayed ? 200 : 201).json(result);
  });
  return router;
}
