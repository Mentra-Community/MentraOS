import {Hono} from "hono";
import {NightlyRoutineService} from "../../services/nightly-routine.service";
import {TestRunError} from "../../services/test-result-error";
import type {AppEnv} from "../../types/hono.types";
import {testRunIngestAuth} from "../middleware/test-run-ingest-auth.middleware";
import {frameworkBodyLimit, frameworkJson} from "./framework-json";

/** The trusted scheduler selects one catalog occurrence; it never dispatches a device workflow. */
export function createNightlyRoutinesApi(service = new NightlyRoutineService()) {
  const app = new Hono<AppEnv>();
  app.use("*", testRunIngestAuth);
  app.use("*", async (c, next) => {c.header("Cache-Control", "no-store"); await next();});
  app.onError((error, c) => {
    if (error instanceof TestRunError) {
      const message = [
        'Nightly catalog exceeds the occurrence bound; no members were selected',
        'Routine main source is unavailable; retry the same selection',
        'Routine main history at the occurrence boundary is unavailable; retry the same selection',
      ].includes(error.message) ? error.message : 'Expected nightly request refused (message omitted)';
      c.var.logger?.warn({error: 'nightly_occurrence_error', status: error.status,
        message: message.slice(0, 512)}, 'nightly occurrence refused');
      return c.json({error: "nightly_occurrence_error", message: error.message}, error.status);
    }
    c.var.logger?.error({errorName: error.name}, "nightly occurrence operation failed");
    return c.json({error: "nightly_occurrence_unavailable"}, 503);
  });
  app.post("/", frameworkBodyLimit(4096), async c => c.json(await service.start(await frameworkJson(c)), 202));
  app.get("/:occurrenceId", async c => c.json(await service.detail(c.req.param("occurrenceId"))));
  app.post("/:occurrenceId/complete", async c => c.json(await service.complete(c.req.param("occurrenceId"))));
  app.post("/:occurrenceId/cancel", frameworkBodyLimit(4096), async c =>
    c.json(await service.cancel(c.req.param("occurrenceId"), await frameworkJson(c)), 202));
  return app;
}
