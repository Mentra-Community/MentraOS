import {Hono} from "hono";
import {z} from "zod";
import {bodyLimit} from "hono/body-limit";
import type {AppEnv} from "../../types/hono.types";
import {frameworkIdentitySchema, frameworkRequestInputSchema} from "../../types/framework-request.types";
import {TestRequestConflict, TestRequestService} from "../../services/test-request.service";
import {TestRunError} from "../../services/test-result-error";
import {RoutineDefinitionService} from "../../services/routine-definition.service";
import {GithubTestBuildGateway, TestDispatchError, type TestBuildGateway} from "../../services/test-builds.service";
import {selectedBuildInput, testBuildQuerySchema, testBuildSourceSchema} from "../../types/test-build.types";
const pickerSubmission = z.object({requestId: frameworkIdentitySchema, hostId: frameworkIdentitySchema, laneId: frameworkIdentitySchema, routineId: z.string(), platform: z.enum(["ios-on-mac", "android"]), source: testBuildSourceSchema, archiveSha256: z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const submission = z.object({requestId: frameworkIdentitySchema, hostId: frameworkIdentitySchema, input: frameworkRequestInputSchema}).strict();
/** Admin submits the same immutable request consumed by the host, without a second GitHub scheduler. */
export function createTestDispatchAdminApi(service = new TestRequestService(), definitions = new RoutineDefinitionService(), builds: TestBuildGateway = new GithubTestBuildGateway()) {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof TestDispatchError) return c.json({error: "build_unavailable", message: error.message}, error.status);
    if (error instanceof TestRequestConflict) return c.json({error: "request_conflict", message: error.message}, 409);
    if (error instanceof TestRunError) return c.json({error: "request_invalid", message: error.message}, error.status);
    c.var.logger?.error({errorName: error.name}, "routine request admission failed");
    return c.json({error: "request_admission_unavailable"}, 503);
  });
  app.get("/test-builds", async c => {
    const query = testBuildQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({error: "invalid_build_query"}, 400);
    return c.json({builds: await builds.inventory(query.data)});
  });
  app.post("/test-dispatches/picker", bodyLimit({maxSize: 4096}), async c => {
    if (c.req.header("content-type")?.split(";")[0] !== "application/json") return c.json({error: "JSON required"}, 400);
    const parsed = pickerSubmission.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({error: "invalid_submission"}, 400);
    const selected = parsed.data;
    const definition = await definitions.getCurrent(selected.routineId, selected.platform);
    if (!definition) return c.json({error: "routine_not_enrolled"}, 409);
    const build = await builds.resolve(selected.source, selected.platform);
    if (build.availability !== "available" || !build.archive || !build.receipt || build.archive.sha256 !== selected.archiveSha256)
      return c.json({error: "selected_build_changed", message: build.reason ?? "Refresh the build list."}, 409);
    const input = {routineId: selected.routineId, definitionRevision: definition.definitionRevision,
      platform: selected.platform, laneId: selected.laneId,
      build: selectedBuildInput(build, selected.platform)};
    // Keep finite JSON: optional publisher fields are omitted rather than hashed as undefined.
    return c.json(await service.submit(selected.requestId, selected.hostId, JSON.parse(JSON.stringify(input))), 202);
  });
  app.post("/test-dispatches", bodyLimit({maxSize: 65536}), async c => {
    if (c.req.header("content-type")?.split(";")[0] !== "application/json") return c.json({error: "JSON required"}, 400);
    const parsed = submission.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({error: "invalid_submission"}, 400);
    const {requestId, hostId, input} = parsed.data;
    const definition = await definitions.getCurrent(input.routineId, input.platform);
    if (!definition || definition.definitionRevision !== input.definitionRevision)
      return c.json({error: "routine_not_enrolled_for_host"}, 409);
    return c.json(await service.submit(requestId, hostId, input), 202);
  });
  return app;
}
export default createTestDispatchAdminApi();
