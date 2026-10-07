import {Hono} from "hono";
import {z} from 'zod';
import {RoutineDispatchService} from "../../services/routine-dispatch.service";
import {TestRunError} from "../../services/test-result-error";
import {TestDispatchError} from "../../services/test-builds.service";
import {TestRequestConflict} from "../../services/test-request.service";
import type {AppEnv} from "../../types/hono.types";
import {testRunIngestAuth} from "../middleware/test-run-ingest-auth.middleware";
import {frameworkBodyLimit, frameworkJson} from "./framework-json";

export function createRoutineDispatchesApi(service = new RoutineDispatchService()) {
  const app = new Hono<AppEnv>();
  for (const path of ["/routine-catalog", "/routine-dispatches", "/routine-dispatches/*"]) {
    app.use(path, testRunIngestAuth);
    app.use(path, async (c, next) => {c.header("Cache-Control", "no-store"); await next();});
  }
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({error: 'routine_dispatch_error', message: 'Invalid source selection'}, 400);
    if (error instanceof TestRunError || error instanceof TestDispatchError) return c.json({error: "routine_dispatch_error", message: error.message}, error.status);
    if (error instanceof TestRequestConflict) return c.json({error: "routine_request_conflict", message: error.message}, 409);
    c.var.logger?.error({errorName: error.name}, "native routine request operation failed");
    return c.json({error: "routine_dispatch_unavailable"}, 503);
  });
  app.get("/routine-catalog", async c => c.json(await service.catalog(c.req.query('revision'))));
  app.post("/routine-dispatches", frameworkBodyLimit(4096), async c => c.json(await service.submit(await frameworkJson(c)), 202));
  app.get("/routine-dispatches/:requestId", async c => c.json(await service.detail(c.req.param("requestId"))));
  return app;
}
