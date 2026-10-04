import {Hono} from "hono";
import {bodyLimit} from "hono/body-limit";
import {z} from "zod";
import {RoutineCatalogError, RoutineCatalogService} from "../../services/routine-catalog.service";
import type {AppEnv} from "../../types/hono.types";

/** Mounted under /api/admin/routines behind the existing Admin authentication gate. */
export function createRoutinePreferencesApi(service = new RoutineCatalogService()) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {c.header("Cache-Control", "no-store"); await next();});
  app.onError((error, c) => {
    if (error instanceof RoutineCatalogError) return c.json({error: "routine_preference_error", message: error.message}, error.status);
    c.var.logger?.error({errorName: error.name}, "routine preference update failed");
    return c.json({error: "routine_preference_unavailable"}, 503);
  });
  app.patch("/:routineId/platforms/:platform/preferences", bodyLimit({maxSize: 1024,
    onError: c => c.json({error: "routine_preference_body_too_large"}, 413)}), async c => {
    if (c.req.header("content-type")?.split(";")[0] !== "application/json") return c.json({error: "JSON required"}, 400);
    const parsed = z.object({nightlyEnabled: z.boolean()}).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({error: "invalid_routine_preference"}, 400);
    return c.json(await service.setPreference(c.req.param("routineId"), c.req.param("platform"), parsed.data.nightlyEnabled));
  });
  return app;
}
