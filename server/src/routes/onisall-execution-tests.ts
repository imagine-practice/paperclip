import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { onisallExecutionTestService } from "../services/onisall/execution-tests.js";

export function onisallExecutionTestRoutes(db: Db) {
  const router = Router(), base = "/companies/:companyId/onisall/execution-tests";
  router.use(base, (req, res, next) => {
    assertBoard(req);
    if (!req.actor.userId || req.actor.source === "mcp_oauth") throw forbidden("Direct board session required");
    assertCompanyAccess(req, z.string().uuid().parse(req.params.companyId));
    z.strictObject({}).parse(req.query);
    res.setHeader("Cache-Control", "no-store"); next();
  });
  router.get(base, async (req, res) => res.json(await onisallExecutionTestService(db, req.actor).list(req.params.companyId as string)));
  router.get(`${base}/runs/:runId/evaluation`, async (req, res) => {
    res.json(await onisallExecutionTestService(db, req.actor).evaluate(req.params.companyId as string, z.string().uuid().parse(req.params.runId)));
  });
  router.get(`${base}/runs/:runId/evidence`, async (req, res) => {
    const evidence = await onisallExecutionTestService(db, req.actor).evaluate(req.params.companyId as string, z.string().uuid().parse(req.params.runId));
    res.setHeader("Content-Disposition", 'attachment; filename="execution-test-evidence.json"');
    res.setHeader("X-Content-Type-Options", "nosniff"); res.type("application/json").send(JSON.stringify(evidence, null, 2) + "\n");
  });
  return router;
}
