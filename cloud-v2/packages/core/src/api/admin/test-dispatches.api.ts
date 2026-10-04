import {Hono} from "hono";
import {z} from "zod";
import {bodyLimit} from "hono/body-limit";
import type {AppEnv} from "../../types/hono.types";
import {frameworkIdentitySchema, frameworkRequestInputSchema} from "../../types/framework-request.types";
import {TestRequestConflict, TestRequestService} from "../../services/test-request.service";
import {TestRunError} from "../../services/test-result-error";
import {RoutineDefinitionService} from "../../services/routine-definition.service";
import {GithubTestBuildGateway, TestDispatchError, type TestBuildGateway} from "../../services/test-builds.service";
import {TestHostStateService} from "../../services/test-host-state.service";
import {requestInputDigest} from "../../services/test-request.service";
import {testBuildQuerySchema, testBuildSourceSchema} from "../../types/test-build.types";
import {routineAdmissionInput} from "../../services/routine-admission.service";
const pickerSubmission = z.object({requestId: frameworkIdentitySchema, hostId: frameworkIdentitySchema, laneId: frameworkIdentitySchema, routineId: z.string(), platform: z.enum(["ios-on-mac", "android"]), source: testBuildSourceSchema, archiveSha256: z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const submission = z.object({requestId: frameworkIdentitySchema, hostId: frameworkIdentitySchema, input: frameworkRequestInputSchema}).strict();
export const HOST_STATE_FRESHNESS_MS = 120_000;
/** Admin submits the same immutable request consumed by the host, without a second GitHub scheduler. */
export function createTestDispatchAdminApi(service = new TestRequestService(), definitions = new RoutineDefinitionService(), builds: TestBuildGateway = new GithubTestBuildGateway(), hosts = new TestHostStateService()) {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof TestDispatchError) return c.json({error: "build_unavailable", message: error.message}, error.status);
    if (error instanceof TestRequestConflict) return c.json({error: "request_conflict", message: error.message}, 409);
    if (error instanceof TestRunError) return c.json({error: "request_invalid", message: error.message}, error.status);
    c.var.logger?.error({errorName: error.name}, "routine request admission failed");
    return c.json({error: "request_admission_unavailable"}, 503);
  });
  app.get("/test-routines", async c => c.json({routines: (await definitions.current()).filter(row => row.definition.execution)}));
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
    const existing = await service.get(selected.requestId);
    if (existing) {
      const prior = existing.input as z.infer<typeof frameworkRequestInputSchema>;
      const build = prior.build as Record<string, any>;
      if (existing.hostId !== selected.hostId || prior.routineId !== selected.routineId || prior.platform !== selected.platform || prior.laneId !== selected.laneId
        || requestInputDigest(build.source) !== requestInputDigest(selected.source) || build.archive?.sha256 !== selected.archiveSha256)
        throw new TestRequestConflict("Request retry differs from its original selected build or lane");
      return c.json(existing, 202);
    }
    const definition = await definitions.getCurrent(selected.routineId, selected.platform);
    if (!definition) return c.json({error: "routine_not_enrolled"}, 409);
    const build = await builds.resolve(selected.source, selected.platform);
    if (build.availability !== "available" || !build.archive || !build.receipt || build.archive.sha256 !== selected.archiveSha256)
      return c.json({error: "selected_build_changed", message: build.reason ?? "Refresh the build list."}, 409);
    const snapshot = await hosts.get(selected.hostId);
    const lane = snapshot?.lanes.find(lane => lane.id === selected.laneId && lane.platform === selected.platform);
    const execution = definition.definition.execution;
    if (!snapshot || Date.now() - Date.parse(snapshot.receivedAt) > HOST_STATE_FRESHNESS_MS || !lane || !execution)
      return c.json({error: "host_unavailable", message: "Selected host has no current matching execution capability."}, 409);
    const input = routineAdmissionInput(definition, build, {hostId: selected.hostId, laneId: selected.laneId}, snapshot,
      Date.now(), {requireAutomatic: false});
    // Keep finite JSON: optional publisher fields are omitted rather than hashed as undefined.
    return c.json(await service.submit(selected.requestId, selected.hostId, JSON.parse(JSON.stringify(input))), 202);
  });
  app.post("/test-dispatches", bodyLimit({maxSize: 65536}), async c => {
    if (c.req.header("content-type")?.split(";")[0] !== "application/json") return c.json({error: "JSON required"}, 400);
    const parsed = submission.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({error: "invalid_submission"}, 400);
    const {requestId, hostId, input} = parsed.data;
    const existing = await service.get(requestId);
    if (existing) {
      if (existing.hostId !== hostId || existing.inputSha256 !== requestInputDigest(input)) throw new TestRequestConflict("Request retry changed immutable input");
      return c.json(existing, 202);
    }
    const definition = await definitions.getCurrent(input.routineId, input.platform);
    if (!definition || definition.definitionRevision !== input.definitionRevision)
      return c.json({error: "routine_not_enrolled_for_host"}, 409);
    const selected = input.build as Record<string, unknown>;
    const source = testBuildSourceSchema.safeParse(selected.source);
    if (!source.success) return c.json({error: "published_build_required"}, 400);
    const resolved = await builds.resolve(source.data, input.platform);
    if (resolved.availability !== "available")
      return c.json({error: "selected_build_changed"}, 409);
    const snapshot = await hosts.get(hostId), lane = snapshot?.lanes.find(lane => lane.id === input.laneId && lane.platform === input.platform);
    const execution = definition.definition.execution;
    if (!snapshot || Date.now() - Date.parse(snapshot.receivedAt) > HOST_STATE_FRESHNESS_MS || !lane || !execution)
      return c.json({error: "host_unavailable"}, 409);
    const expected = routineAdmissionInput(definition, resolved, {hostId, laneId: input.laneId}, snapshot,
      Date.now(), {requireAutomatic: false});
    if (requestInputDigest(expected.build) !== requestInputDigest(input.build))
      return c.json({error: "selected_build_changed"}, 409);
    if (requestInputDigest(expected) !== requestInputDigest(input))
      return c.json({error: "host_input_changed"}, 409);
    return c.json(await service.submit(requestId, hostId, input), 202);
  });
  return app;
}
export default createTestDispatchAdminApi();
