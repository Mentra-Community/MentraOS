import {Hono} from "hono";
import type {AppEnv} from "../../types/hono.types";
import {TestRerunService} from "../../services/test-rerun.service";
import {TestRunError} from "../../services/test-result-error";
import {testRunIngestAuth} from "../middleware/test-run-ingest-auth.middleware";
import {frameworkBodyLimit, frameworkJson} from "./framework-json";

/** Shared route builder: mounted behind internal capability or existing Admin authentication. */
export function createTestRerunRoutes(service = new TestRerunService(), audience: "internal" | "admin" = "internal") {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {c.header("Cache-Control", "no-store"); await next();});
  app.onError((error, c) => {
    if (error instanceof TestRunError) return c.json({error: "test_rerun_error", message: error.message}, error.status);
    c.var.logger?.error({errorName: error.name}, "test rerun unavailable");
    return c.json({error: "test_rerun_unavailable", message: "Rerun unavailable; reconcile the original ID before retrying"}, 503);
  });
  const actor = (c: Parameters<typeof frameworkJson>[0]) => audience === "admin" ?
    `admin:${c.var.developer?.developerId ?? "authenticated"}` : "internal:ingest";
  app.post("/preview", frameworkBodyLimit(16384), async c => c.json(await service.preview(await frameworkJson(c), actor(c))));
  app.post("/individual", frameworkBodyLimit(8192), async c => c.json(await service.individual(await frameworkJson(c), actor(c))));
  app.post("/submit", frameworkBodyLimit(4096), async c => c.json(await service.submit(await frameworkJson(c)), 202));
  app.get("/suite/:suiteId/progress", async c => c.json(await service.progress(c.req.param("suiteId"))));
  app.get("/suite/:suiteId/children", async c => c.json(await service.children(c.req.param("suiteId"), c.req.query("before"))));
  app.get("/suite/:suiteId/members/:memberId/history", async c => c.json(await service.history({suiteId:c.req.param("suiteId")},
    c.req.param("memberId"), c.req.query("before") ? Number(c.req.query("before")) : undefined,
    c.req.query("limit") ? Number(c.req.query("limit")) : undefined)));
  app.get("/request/:requestId/history", async c => c.json(await service.history({requestId:c.req.param("requestId")},
    c.req.param("requestId"), c.req.query("before") ? Number(c.req.query("before")) : undefined)));
  app.get("/request/:requestId/lineage", async c => c.json(await service.lineage(c.req.param("requestId"))));
  app.get("/:rerunId", async c => c.json(await service.detail(c.req.param("rerunId"))));
  return app;
}
export function createTestRerunsApi(service = new TestRerunService()) {
  const app = new Hono<AppEnv>();
  app.use("*", testRunIngestAuth);
  app.route("/", createTestRerunRoutes(service));
  return app;
}
