import {Hono} from "hono";
import {RoutineCatalogError, RoutineCatalogService} from "../../services/routine-catalog.service";
import type {AppEnv} from "../../types/hono.types";
import {TestRunError} from "../../services/test-run.service";
import {FrameworkResultService} from "../../services/framework-result.service";

/** Mounted behind the existing Admin authentication gate. */
export function createRoutineCatalogApi(service = new RoutineCatalogService(), results = new FrameworkResultService()) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {c.header("Cache-Control", "no-store"); await next();});
  app.onError((error, c) => {
    if (error instanceof TestRunError) return c.json({error: "routine_asset_error", message: error.message}, error.status);
    if (error instanceof RoutineCatalogError) return c.json({error: "routine_catalog_error", message: error.message}, error.status);
    c.var.logger?.error({errorName: error.name}, "routine catalog query failed");
    return c.json({error: "routine_catalog_unavailable"}, 503);
  });
  app.get("/", async c => c.json({routines: await service.list()}));
  app.get("/results/by-request/:requestId", c => results.detail(c.req.param("requestId")).then(result => c.json(result)));
  app.on(["GET", "HEAD"], "/results/by-request/:requestId/assets/:assetId", c => results.media(
    c.req.param("requestId"), c.req.param("assetId"), c.req.raw));
  app.get("/:routineId/:platform", async c => c.json(await service.detail(c.req.param("routineId"),
    c.req.param("platform"), c.req.query("cursor"), Number(c.req.query("limit") ?? 25))));
  return app;
}
