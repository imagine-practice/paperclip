import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { forbidden, unauthorized } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { onisallFrozenRuleSetService } from "../services/onisall/frozen-rule-sets.js";

export function onisallRuleSetRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const base = "/companies/:companyId/onisall/rule-sets";
  router.use(base, (req, res, next) => {
    assertBoard(req);
    if (req.actor.source === "mcp_oauth") throw forbidden("Direct board session required");
    const companyId = z.string().uuid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    if (!req.actor.userId) throw unauthorized();
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.get(base, async (req, res) => {
    const query = z.strictObject({ offset: z.string().regex(/^(0|[1-9][0-9]{0,5})$/).transform(Number).refine(n => n <= 100000).optional() }).parse(req.query);
    res.json(await onisallFrozenRuleSetService(db, storage, req.actor).list(req.params.companyId as string, query.offset ?? 0));
  });
  router.get(base + "/:id", async (req, res) => {
    z.strictObject({}).parse(req.query);
    const id = z.string().uuid().parse(req.params.id);
    res.json(await onisallFrozenRuleSetService(db, storage, req.actor).get(req.params.companyId as string, id));
  });
  return router;
}
