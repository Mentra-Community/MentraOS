import {Hono} from "hono";
import {createTestHostAuth, type TestHostEnv} from "../middleware/test-host-auth.middleware";
import {frameworkBodyLimit, frameworkJson} from "./framework-json";
import {StateRepairDiagnosticsService, STATE_REPAIR_DIAGNOSTIC_BYTES} from "../../services/state-repair-diagnostics.service";
import {ReportArtifactError} from "../../services/report.service";
import {TestRunError} from "../../services/test-result-error";

export function createStateRepairDiagnosticsApi(service = new StateRepairDiagnosticsService(), credentials?: () => string | undefined) {
  const app = new Hono<TestHostEnv>();
  app.use("*", createTestHostAuth(credentials));
  app.use("*", frameworkBodyLimit(STATE_REPAIR_DIAGNOSTIC_BYTES + 1024 * 1024));
  app.onError((error, c) => {
    if (error instanceof TestRunError || error instanceof ReportArtifactError)
      return c.json({error: "repair_diagnostics_error", message: error.message}, error.status);
    c.var.logger?.error({errorName: error.name}, "Repair diagnostic publication failed");
    return c.json({error: "repair_diagnostics_unavailable"}, 503);
  });
  app.post("/:interruptionId/diagnostics", async c => c.json(await service.publish(
    c.var.testHostId, c.req.param("interruptionId"), await frameworkJson(c))));
  return app;
}
