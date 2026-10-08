import {Hono} from "hono";
import {mongo} from "mongoose";
import {frameworkBodyLimit, frameworkJson} from "./framework-json";
import {FrameworkResultConflict, FrameworkResultService} from "../../services/framework-result.service";
import {TestRunError} from "../../services/test-result-error";
import {createTestHostAuth, type TestHostEnv} from "../middleware/test-host-auth.middleware";

const errorText = (value: string | undefined) => value?.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[redacted Mongo URI]")
  .replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 1000);

/** Keep database failure details, never bulk operation bodies or credentials. */
function publicationErrorDetails(error: Error) {
  const details = {errorName: error.name, errorMessage: errorText(error.message)};
  if (!(error instanceof mongo.MongoServerError)) return details;
  const database = {errorCode: error.code, errorCodeName: error.codeName};
  if (!(error instanceof mongo.MongoBulkWriteError)) return {...details, ...database};
  const concern = error.result.getWriteConcernError();
  const writes = Array.isArray(error.writeErrors) ? error.writeErrors : [error.writeErrors];
  return {...details, ...database, writeErrorCount: writes.length,
    writeErrors: writes.slice(0, 10).map(item => ({index: item.index, code: item.code, message: errorText(item.errmsg)})),
    ...(concern ? {writeConcernError: {code: concern.code, message: errorText(concern.errmsg)}} : {})};
}

export function createFrameworkResultsApi(service = new FrameworkResultService(), credentials?: () => string | undefined) {
  const app = new Hono<TestHostEnv>();
  app.use("*", createTestHostAuth(credentials));
  app.use('*', async (c, next) => {c.header('Cache-Control', 'private, no-store'); await next();});
  app.onError((error, c) => {
    if (error instanceof FrameworkResultConflict) return c.json({error: "result_conflict", message: error.message}, 409);
    if (error instanceof TestRunError) return c.json({error: "asset_error", message: error.message}, error.status);
    c.var.logger?.error(publicationErrorDetails(error), "framework result publication failed");
    return c.json({error: "result_publication_unavailable"}, 503);
  });
  app.post("/", frameworkBodyLimit(), async c => {
    let input: unknown;
    input = await frameworkJson(c);
    return c.json(await service.ingest(input, c.var.testHostId));
  });
  app.put("/:requestId/assets/:assetId", async c => c.json(await service.upload(c.req.param("requestId"),
    c.req.param("assetId"), c.var.testHostId, c.req.raw.body, c.req.raw.headers)));
  app.post("/:requestId/complete", async c => c.json(await service.complete(c.req.param("requestId"), c.var.testHostId)));
  app.get('/:requestId', async c => c.json(await service.detailForHost(c.req.param('requestId'), c.var.testHostId)));
  app.on(['GET', 'HEAD'], '/:requestId/assets/:assetId', c => service.mediaForHost(c.req.param('requestId'),
    c.req.param('assetId'), c.var.testHostId, c.req.raw));
  return app;
}
