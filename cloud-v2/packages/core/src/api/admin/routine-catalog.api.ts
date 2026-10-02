import {Hono} from "hono";
import {RoutineCatalogError, RoutineCatalogService} from "../../services/routine-catalog.service";
import type {AppEnv} from "../../types/hono.types";

/** Mounted behind the existing Admin authentication gate. */
export function createRoutineCatalogApi(service = new RoutineCatalogService()) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {c.header("Cache-Control", "no-store"); await next();});
  app.onError((error, c) => {
    if (error instanceof RoutineCatalogError) return c.json({error: "routine_catalog_error", message: error.message}, error.status);
    c.var.logger?.error({errorName: error.name}, "routine catalog query failed");
    return c.json({error: "routine_catalog_unavailable"}, 503);
  });
  app.get("/", async c => c.json({routines: await service.list()}));
  app.get("/:routineId/:platform", async c => c.json(await service.detail(c.req.param("routineId"),
    c.req.param("platform"), c.req.query("cursor"), Number(c.req.query("limit") ?? 25))));
  return app;
}
