import {TestPendingQueueService} from "../../services/test-pending-queue.service";
import {Hono} from "hono";
import type {AppEnv} from "../../types/hono.types";
import {FrameworkResultService} from "../../services/framework-result.service";
import {TestSuiteService} from "../../services/test-suite.service";
import {TestRunError} from "../../services/test-result-error";
import {TestHostHealthError, TestHostHealthService} from "../../services/test-host-health.service";
import {TestRequestModel} from "../../models/test-request.model";
import {TestHistoryService} from "../../services/test-history.service";
import {hostCancellationSchema, hostRejectionSchema, requestInputDigest, isExecutableRequest, TestRequestService, type StoredRequest} from "../../services/test-request.service";
import {frameworkIdentitySchema, recordedFrameworkRequestInputSchema, type FrameworkRequestDisplay} from "../../types/framework-request.types";
import {createTestRerunRoutes} from "../internal/test-reruns.api";
import {routineDispatchIntentSchema} from '../../types/routine-dispatch.types';
import {portableRoutineSelectionSchema, type StoredRoutineJob} from '../../types/routine-job.types';
import {LaneRestorationService} from "../../services/lane-restoration.service";

/** Results and delivery projections only; the host controller owns lanes and repairs. */
export function createTestRunAdminApi(health = new TestHostHealthService(), history = new TestHistoryService(),
  results = new FrameworkResultService(), requests = new TestRequestService(), restoration = new LaneRestorationService()) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {c.header("Cache-Control", "no-store"); await next();});
  app.onError((error, c) => {
    if (error instanceof TestRunError || error instanceof TestHostHealthError)
      return c.json({error: "test_run_error", message: error.message}, error.status);
    c.var.logger?.error({errorName: error.name}, "test result query failed");
    return c.json({error: "test_results_unavailable"}, 503);
  });
  const suites = new TestSuiteService();
  app.route("/reruns", createTestRerunRoutes(undefined, "admin"));
  app.get("/suite-index/labels", async c => c.json(await suites.labels((c.req.query("requestIds") ?? "").split(",").filter(Boolean))));
  app.get("/suite-index/list", async c => c.json(await suites.list()));
  app.get("/history/list", async c => c.json(await history.list(c.req.query())));
  app.get("/suites/:suiteId/summary", async c => c.json(await suites.summary(c.req.param("suiteId"))));
  app.get("/suites/:suiteId", async c => c.json(await suites.detail(c.req.param("suiteId"))));
  app.get("/", async c => c.json(await results.list(c.req.query())));
  app.get("/pending-queue", async c => c.json(await new TestPendingQueueService().list(c.req.query("cursor"))));
  app.get("/activity", async c => c.json({requests: await TestRequestModel.find({state: {$ne: "terminal"}})
    .sort({createdAt: 1, requestId: 1}).limit(100).select({requestId: 1, hostId: 1, state: 1, input: 1, inputSha256: 1, dispatchIntent: 1, dispatchIntentSha256: 1, preparation: 1, preparationRejection: 1, preparationCancellation: 1, hostReceipt: 1, hostRejection: 1, hostCancellation: 1, cancellationAcknowledged: 1, createdAt: 1, fleetSelection: 1, fleetSelectionSha256: 1, fleetInputSha256: 1, fleetBinding: 1, fleetCancellation: 1, fleetDispatch: 1, fleetActions: 1})
    .read("primary").readConcern("majority").lean().then(rows => rows.map(row => displayRequest(row as StoredRequest)))}));
  app.get("/health", async c => c.json(await health.list()));
  app.get("/health/:hostId", async c => c.json(await health.history(c.req.param("hostId"), c.req.query("days"))));
  app.get("/lanes/overview", async c => c.json(await restoration.overview()));
  app.get("/restoration/list", async c => c.json(await restoration.list(c.req.query('hostId'))));
  app.get("/:runId", async c => {
    const id = c.req.param("runId");
    if (!frameworkIdentitySchema.safeParse(id).success) throw new TestRunError(400, "Invalid run or request identity");
    try {return c.json({kind: "run", ...await results.detailByRun(id, true)});}
    catch (error) {if (!(error instanceof TestRunError) || error.status !== 404) throw error;}
    try {return c.json({kind: "run", ...await results.detail(id, true)});}
    catch (error) {if (!(error instanceof TestRunError) || error.status !== 404) throw error;}
    const row = await requests.get(id);
    if (!row) throw new TestRunError(404, "Routine run or request was not found");
    return c.json({kind: "request", request: displayRequest(row)});
  });
  app.on(["GET", "HEAD"], "/:runId/assets/:assetId", c => results.mediaByRun(c.req.param("runId"), c.req.param("assetId"), c.req.raw));
  return app;
}
function displayRequest(row: StoredRequest): FrameworkRequestDisplay {
    const fleet = row as unknown as StoredRoutineJob;
    if (fleet.fleetSelection && !fleet.fleetBinding) {
      const parsed = portableRoutineSelectionSchema.safeParse(fleet.fleetSelection);
      if (!parsed.success || requestInputDigest(parsed.data) !== fleet.fleetSelectionSha256)
        throw new TestRunError(503, 'Stored fleet request identity is unavailable');
      const selected = parsed.data;
      return {requestId: row.requestId, routineId: selected.routineId, platform: selected.platform,
        definitionRevision: selected.routineRevision, ...(selected.routineSource ? {routineSource: selected.routineSource} : {}),
        minimumFrameworkVersion: selected.minimumFrameworkVersion, build: selected.build, state: fleet.state,
        terminalStatus: fleet.terminalStatus, createdAt: fleet.createdAt?.toISOString(),
        reason: fleet.fleetCancellation?.reason ?? fleet.fleetDispatch?.error ?? (fleet.state === 'awaiting-source' ?
          'Preparing the exact routine source.' : 'Awaiting a compatible testing runner.'),
        ...(fleet.fleetCancellation ? {cancellationRequested: true, cancellationAcknowledged: true} : {}),
        actionsRuns: fleet.fleetActions ?? []};
    }
    if (!isExecutableRequest(row)) {
      const parsedIntent = routineDispatchIntentSchema.safeParse(row.dispatchIntent);
      if (!parsedIntent.success || requestInputDigest(parsedIntent.data) !== row.dispatchIntentSha256) throw new TestRunError(503, 'Stored preparation identity is unavailable');
      const intent = parsedIntent.data, reason = row.preparationRejection ?? row.preparation ?? row.preparationCancellation;
      const request: FrameworkRequestDisplay = {requestId: row.requestId, hostId: row.hostId, dispatchIntentSha256: row.dispatchIntentSha256,
        routineId: intent.routineId, platform: intent.platform, definitionRevision: intent.routineRevision, laneId: intent.laneId,
        build: intent.build, state: row.state, terminalStatus: row.terminalStatus, minimumFrameworkVersion: intent.minimumFrameworkVersion,
        createdAt: row.createdAt?.toISOString(), reason: reason?.reason ?? 'The test computer is preparing this exact routine source.',
        reasonAt: row.preparationRejection?.rejectedAt ?? row.preparation?.observedAt ?? row.preparationCancellation?.requestedAt,
        ...(row.preparationRejection ? {preparationDisposition: row.preparationRejection.disposition} : {}),
        ...(row.preparationCancellation ? {cancellationRequested: true, cancellationAcknowledged: true} : {})};
      if (fleet.fleetBinding) {request.assignment = fleet.fleetBinding;request.actionsRuns = fleet.fleetActions ?? [];}
      return request;
    }
    const parsed = recordedFrameworkRequestInputSchema.safeParse(row.input);
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
      ...(input.routineSource ? {routineSource: input.routineSource} : {}),
      ...(input.minimumFrameworkVersion !== undefined ? {minimumFrameworkVersion: input.minimumFrameworkVersion} : {}),
      laneId: input.laneId, build: input.build, state: row.state, terminalStatus: row.terminalStatus,
      createdAt: row.createdAt?.toISOString(), acceptedAt: row.hostReceipt?.acceptedAt,
      reason: !row.runId && row.publicationFailure ? `Publication failed: ${row.publicationFailure.message}` : rejection ? `${rejection.code}: ${rejection.reason}` : cancellation?.reason,
      reasonAt: !row.runId && row.publicationFailure ? row.publicationFailure.rejectedAt : rejection?.rejectedAt ?? cancellation?.requestedAt,
      ...(cancellation ? {cancellationRequested: true, cancellationAcknowledged: row.cancellationAcknowledged === true} : {})};
    if (fleet.fleetBinding) {request.assignment = fleet.fleetBinding;request.actionsRuns = fleet.fleetActions ?? [];}
    return request;
}
export default createTestRunAdminApi();
