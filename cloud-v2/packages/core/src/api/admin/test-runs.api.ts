import {Hono} from "hono";
import type {AppEnv} from "../../types/hono.types";
import {FrameworkResultService} from "../../services/framework-result.service";
import {TestSuiteService} from "../../services/test-suite.service";
import {TestRunError} from "../../services/test-result-error";
import {TestHostHealthError, TestHostHealthService} from "../../services/test-host-health.service";
import {TestRequestModel} from "../../models/test-request.model";
import {TestHistoryService} from "../../services/test-history.service";

/** Results and delivery projections only; the host controller owns lanes and repairs. */
export function createTestRunAdminApi(health = new TestHostHealthService(), history = new TestHistoryService()) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {c.header("Cache-Control", "no-store"); await next();});
  app.onError((error, c) => {
    if (error instanceof TestRunError || error instanceof TestHostHealthError)
      return c.json({error: "test_run_error", message: error.message}, error.status);
    c.var.logger?.error({errorName: error.name}, "test result query failed");
    return c.json({error: "test_results_unavailable"}, 503);
  });
  const suites = new TestSuiteService(), results = new FrameworkResultService();
  app.get("/suite-index/labels", async c => c.json(await suites.labels((c.req.query("requestIds") ?? "").split(",").filter(Boolean))));
  app.get("/suite-index/list", async c => c.json(await suites.list()));
  app.get("/history", async c => c.json(await history.list(c.req.query())));
  app.get("/suites/:suiteId", async c => c.json(await suites.detail(c.req.param("suiteId"))));
  app.get("/", async c => c.json(await results.list(c.req.query())));
  app.get("/activity", async c => c.json({requests: await TestRequestModel.find({state: {$ne: "terminal"}})
    .sort({createdAt: 1, requestId: 1}).limit(100).select({requestId: 1, hostId: 1, state: 1, input: 1, createdAt: 1})
    .read("primary").readConcern("majority").lean()}));
  app.get("/health", async c => c.json(await health.list()));
  app.get("/health/:hostId", async c => c.json(await health.history(c.req.param("hostId"), c.req.query("days"))));
  app.get("/:runId", async c => c.json(await results.detailByRun(c.req.param("runId"))));
  app.on(["GET", "HEAD"], "/:runId/assets/:assetId", c => results.mediaByRun(c.req.param("runId"), c.req.param("assetId"), c.req.raw));
  return app;
}
export default createTestRunAdminApi();
