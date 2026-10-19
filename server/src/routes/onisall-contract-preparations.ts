import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { forbidden, unauthorized } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { onisallContractPreparationService } from "../services/onisall/contract-preparations.js";

export function onisallContractPreparationRoutes(db: Db, storage: StorageService) {
  const router = Router(), base = "/companies/:companyId/onisall/intakes/:intakeId/contract-preparations";
  router.use(base, (req, res, next) => {
    assertBoard(req);
    if (req.actor.source === "mcp_oauth") throw forbidden("Direct board session required");
    const companyId = z.string().uuid().parse(req.params.companyId);
    z.string().uuid().parse(req.params.intakeId);
    assertCompanyAccess(req, companyId);
    if (!req.actor.userId) throw unauthorized();
    res.setHeader("Cache-Control", "no-store"); next();
  });
  router.get(base, async (req, res) => {
    const query = z.strictObject({ offset: z.string().regex(/^(0|[1-9][0-9]{0,5})$/).transform(Number).refine(n => n <= 100000).optional() }).parse(req.query);
    res.json(await onisallContractPreparationService(db, storage, req.actor).list(req.params.companyId as string, req.params.intakeId as string, query.offset ?? 0));
  });
  router.get(base + "/:id", async (req, res) => {
    z.strictObject({}).parse(req.query);
    const id = z.string().uuid().parse(req.params.id);
    res.json(await onisallContractPreparationService(db, storage, req.actor).get(req.params.companyId as string, req.params.intakeId as string, id));
  });
  return router;
}
