import {Hono} from "hono";
import type {AppEnv} from "../../types/hono.types";
import {FrameworkResultService} from "../../services/framework-result.service";
import {TestSuiteService} from "../../services/test-suite.service";
import {TestRunError} from "../../services/test-result-error";
import {TestHostHealthError, TestHostHealthService} from "../../services/test-host-health.service";
import {TestRequestModel} from "../../models/test-request.model";
import {TestHistoryService} from "../../services/test-history.service";
import {hostCancellationSchema, hostRejectionSchema, requestInputDigest, TestRequestService} from "../../services/test-request.service";
import {frameworkIdentitySchema, frameworkRequestInputSchema, type FrameworkRequestDisplay} from "../../types/framework-request.types";

/** Results and delivery projections only; the host controller owns lanes and repairs. */
export function createTestRunAdminApi(health = new TestHostHealthService(), history = new TestHistoryService(),
  results = new FrameworkResultService(), requests = new TestRequestService()) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {c.header("Cache-Control", "no-store"); await next();});
  app.onError((error, c) => {
    if (error instanceof TestRunError || error instanceof TestHostHealthError)
      return c.json({error: "test_run_error", message: error.message}, error.status);
    c.var.logger?.error({errorName: error.name}, "test result query failed");
    return c.json({error: "test_results_unavailable"}, 503);
  });
  const suites = new TestSuiteService();
  app.get("/suite-index/labels", async c => c.json(await suites.labels((c.req.query("requestIds") ?? "").split(",").filter(Boolean))));
  app.get("/suite-index/list", async c => c.json(await suites.list()));
  app.get("/history/list", async c => c.json(await history.list(c.req.query())));
  app.get("/suites/:suiteId", async c => c.json(await suites.detail(c.req.param("suiteId"))));
  app.get("/", async c => c.json(await results.list(c.req.query())));
  app.get("/activity", async c => c.json({requests: await TestRequestModel.find({state: {$ne: "terminal"}})
    .sort({createdAt: 1, requestId: 1}).limit(100).select({requestId: 1, hostId: 1, state: 1, input: 1, createdAt: 1})
    .read("primary").readConcern("majority").lean()}));
  app.get("/health", async c => c.json(await health.list()));
  app.get("/health/:hostId", async c => c.json(await health.history(c.req.param("hostId"), c.req.query("days"))));
  app.get("/:runId", async c => {
    const id = c.req.param("runId");
    if (!frameworkIdentitySchema.safeParse(id).success) throw new TestRunError(400, "Invalid run or request identity");
    try {return c.json({kind: "run", ...await results.detailByRun(id)});}
    catch (error) {if (!(error instanceof TestRunError) || error.status !== 404) throw error;}
    try {return c.json({kind: "run", ...await results.detail(id)});}
    catch (error) {if (!(error instanceof TestRunError) || error.status !== 404) throw error;}
    const row = await requests.get(id);
    if (!row) throw new TestRunError(404, "Routine run or request was not found");
    const parsed = frameworkRequestInputSchema.safeParse(row.input);
    if (!parsed.success || requestInputDigest(parsed.data) !== row.inputSha256)
      throw new TestRunError(503, "Stored request identity is unavailable");
    const rejection = row.hostRejection ? hostRejectionSchema.parse(row.hostRejection) : undefined;
    const cancellation = row.hostCancellation ? hostCancellationSchema.parse(row.hostCancellation) : undefined;
    const reason = rejection ?? cancellation;
    if (reason && (reason.requestId !== row.requestId || reason.hostId !== row.hostId || reason.inputSha256 !== row.inputSha256))
      throw new TestRunError(503, "Stored request receipt identity is unavailable");
    const input = parsed.data;
    const request: FrameworkRequestDisplay = {requestId: row.requestId, hostId: row.hostId, inputSha256: row.inputSha256,
      routineId: input.routineId, platform: input.platform, definitionRevision: input.definitionRevision,
      laneId: input.laneId, build: input.build, state: row.state, terminalStatus: row.terminalStatus,
      createdAt: row.createdAt?.toISOString(), acceptedAt: row.hostReceipt?.acceptedAt,
      reason: rejection ? `${rejection.code}: ${rejection.reason}` : cancellation?.reason,
      reasonAt: rejection?.rejectedAt ?? cancellation?.requestedAt,
      ...(cancellation ? {cancellationRequested: true, cancellationAcknowledged: row.cancellationAcknowledged === true} : {})};
    return c.json({kind: "request", request});
  });
  app.on(["GET", "HEAD"], "/:runId/assets/:assetId", c => results.mediaByRun(c.req.param("runId"), c.req.param("assetId"), c.req.raw));
  return app;
}
export default createTestRunAdminApi();
