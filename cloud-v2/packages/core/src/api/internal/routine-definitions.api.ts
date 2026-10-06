import {TestRunError} from "../../services/test-result-error";
import {Hono} from "hono";
import {frameworkBodyLimit, frameworkJson} from "./framework-json";
import {RoutineDefinitionConflict, RoutineDefinitionService} from "../../services/routine-definition.service";
import {createTestHostAuth, type TestHostEnv} from "../middleware/test-host-auth.middleware";

/** Trusted controller source enrollment, separate from device result ingestion. */
export function createRoutineDefinitionsApi(service = new RoutineDefinitionService(), credentials?: () => string | undefined) {
  const app = new Hono<TestHostEnv>();
  app.use("*", createTestHostAuth(credentials));
  app.onError((error, c) => {
    if (error instanceof TestRunError) return c.json({error: "invalid_definition", message: error.message}, error.status);
    if (error instanceof RoutineDefinitionConflict) return c.json({error: "definition_conflict", message: error.message}, 409);
    c.var.logger?.error({errorName: error.name}, "routine definition enrollment failed");
    return c.json({error: "definition_enrollment_unavailable"}, 503);
  });
  app.post("/", frameworkBodyLimit(), async c => {
    let input: unknown;
    input = await frameworkJson(c);
    const row = await service.enroll(input, c.var.testHostId);
    return c.json({routineId: row.routineId, platform: row.platform,
      definitionRevision: row.definitionRevision, definitionSha256: row.definitionSha256});
  });
  return app;
}
