import {Hono} from "hono";
import {bodyLimit} from "hono/body-limit";
import {RoutineDefinitionConflict, RoutineDefinitionService} from "../../services/routine-definition.service";
import {createTestHostAuth, type TestHostEnv} from "../middleware/test-host-auth.middleware";

/** Trusted controller source enrollment, separate from device result ingestion. */
export function createRoutineDefinitionsApi(service = new RoutineDefinitionService(), credentials?: () => string | undefined) {
  const app = new Hono<TestHostEnv>();
  app.use("*", createTestHostAuth(credentials));
  app.onError((error, c) => {
    if (error instanceof RoutineDefinitionConflict) return c.json({error: "definition_conflict", message: error.message}, 409);
    c.var.logger?.error({errorName: error.name}, "routine definition enrollment failed");
    return c.json({error: "definition_enrollment_unavailable"}, 503);
  });
  app.post("/", bodyLimit({maxSize: 1024 * 1024}), async c => {
    let input: unknown;
    try {input = await c.req.json();} catch {return c.json({error: "invalid_json"}, 400);}
    const row = await service.enroll(input);
    return c.json({routineId: row.routineId, platform: row.platform,
      definitionRevision: row.definitionRevision, definitionSha256: row.definitionSha256});
  });
  return app;
}
