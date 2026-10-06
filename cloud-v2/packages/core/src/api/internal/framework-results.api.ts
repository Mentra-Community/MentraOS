import {Hono} from "hono";
import {frameworkBodyLimit, frameworkJson} from "./framework-json";
import {FrameworkResultConflict, FrameworkResultService} from "../../services/framework-result.service";
import {TestRunError} from "../../services/test-result-error";
import {createTestHostAuth, type TestHostEnv} from "../middleware/test-host-auth.middleware";

export function createFrameworkResultsApi(service = new FrameworkResultService(), credentials?: () => string | undefined) {
  const app = new Hono<TestHostEnv>();
  app.use("*", createTestHostAuth(credentials));
  app.use('*', async (c, next) => {c.header('Cache-Control', 'private, no-store'); await next();});
  app.onError((error, c) => {
    if (error instanceof FrameworkResultConflict) return c.json({error: "result_conflict", message: error.message}, 409);
    if (error instanceof TestRunError) return c.json({error: "asset_error", message: error.message}, error.status);
    c.var.logger?.error({errorName: error.name}, "framework result publication failed");
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
