import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { forbidden, unauthorized } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { onisallFrozenSchemaSetService } from "../services/onisall/frozen-schema-sets.js";

export function onisallSchemaSetRoutes(db: Db) {
  const router = Router();
  router.get("/companies/:companyId/onisall/schema-sets/:id", async (req, res) => {
    assertBoard(req);
    if (req.actor.source === "mcp_oauth") throw forbidden("Direct board session required");
    const companyId = z.string().uuid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    if (!req.actor.userId) throw unauthorized();
    z.strictObject({}).parse(req.query);
    const id = z.string().uuid().parse(req.params.id);
    res.setHeader("Cache-Control", "no-store");
    res.json(await onisallFrozenSchemaSetService(db, req.actor).get(companyId, id));
  });
  return router;
}
