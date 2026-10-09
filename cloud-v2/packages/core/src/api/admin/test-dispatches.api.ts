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
import {RoutineDispatchService} from "../../services/routine-dispatch.service";
import {routineRevisionSchema} from "../../types/routine-dispatch.types";
import {routineIdentitySchema} from "../../types/routine-definition.types";
import {frameworkVersionSchema} from "../../types/framework-version.types";
import {RoutineJobService} from '../../services/routine-job.service';
import {portableRoutineSelectionSchema} from '../../types/routine-job.types';
import {routineAdmissionInput} from "../../services/routine-admission.service";
const pickerSubmission = z.object({requestId: frameworkIdentitySchema, hostId: frameworkIdentitySchema.optional(), laneId: frameworkIdentitySchema.optional(), routineId: routineIdentitySchema, routineRevision: routineRevisionSchema.optional(), minimumFrameworkVersion: frameworkVersionSchema.optional(), platform: z.enum(["ios-on-mac", "android"]), source: testBuildSourceSchema, archiveSha256: z.string().regex(/^[a-f0-9]{64}$/)}).strict().refine(value => !value.laneId || !!value.hostId, 'A targeted lane requires its host');
const submission = z.object({requestId: frameworkIdentitySchema, hostId: frameworkIdentitySchema, input: frameworkRequestInputSchema}).strict();
export const HOST_STATE_FRESHNESS_MS = 120_000;
/**
 * Admin retains exact selections before the trusted fleet workflow assigns a host. Mounted behind admin.api's
 * `organization.testing.*` gates (read to look, manage to dispatch); worker capability tokens do not grant access.
 */
export function createTestDispatchAdminApi(service = new TestRequestService(), definitions = new RoutineDefinitionService(), builds: TestBuildGateway = new GithubTestBuildGateway(), hosts = new TestHostStateService(),
  dispatch = new RoutineDispatchService(definitions, builds, hosts, service), jobs = new RoutineJobService()) {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof TestDispatchError) return c.json({error: "build_unavailable", message: error.message}, error.status);
    if (error instanceof TestRequestConflict) return c.json({error: "request_conflict", message: error.message}, 409);
    if (error instanceof TestRunError) return c.json({error: "request_invalid", message: error.message}, error.status);
    c.var.logger?.error({errorName: error.name}, "routine request admission failed");
    return c.json({error: "request_admission_unavailable"}, 503);
  });
  app.get("/test-routines", async c => c.json(await dispatch.catalog(c.req.query("revision"))));
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
      const fleet = existing as unknown as {fleetSelection?: unknown; fleetSelectionSha256?: string; fleetTarget?: {hostId?: string; laneId?: string}};
      const prior = portableRoutineSelectionSchema.safeParse(fleet.fleetSelection);
      const target = selected.hostId ? {hostId: selected.hostId, ...(selected.laneId ? {laneId: selected.laneId} : {})} : undefined;
      if (!prior.success || requestInputDigest(prior.data) !== fleet.fleetSelectionSha256)
        throw new TestRunError(503, "Stored picker request has no valid immutable fleet selection");
      if (prior.data.routineId !== selected.routineId || prior.data.platform !== selected.platform ||
        prior.data.minimumFrameworkVersion !== selected.minimumFrameworkVersion ||
        selected.routineRevision && prior.data.routineRevision !== selected.routineRevision ||
        requestInputDigest(prior.data.source) !== requestInputDigest(selected.source) || prior.data.build.archive.sha256 !== selected.archiveSha256 ||
        requestInputDigest(fleet.fleetTarget ?? null) !== requestInputDigest(target ?? null))
        throw new TestRequestConflict("Request retry differs from its original selected source, build or target");
      return c.json(existing, 202);
    }
    const frozen = await jobs.freezeSelection({requestId: selected.requestId, routineId: selected.routineId, platform: selected.platform,
      source: selected.source, ...(selected.routineRevision ? {routineRevision: selected.routineRevision} : {}),
      ...(selected.minimumFrameworkVersion !== undefined ? {minimumFrameworkVersion: selected.minimumFrameworkVersion} : {})});
    if (frozen.build.archive.sha256 !== selected.archiveSha256)
      return c.json({error: "selected_build_changed", message: "Refresh the build list."}, 409);
    return c.json(await jobs.submitFrozen(frozen, new Date(Date.now() + 3 * 3600_000).toISOString(),
      selected.hostId ? {hostId: selected.hostId, ...(selected.laneId ? {laneId: selected.laneId} : {})} : undefined), 202);
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
    const definition = await definitions.getExact(input.routineId, input.platform, input.definitionRevision, true);
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
      Date.now(), {requireAutomatic: false, minimumFrameworkVersion: input.minimumFrameworkVersion});
    if (requestInputDigest(expected.build) !== requestInputDigest(input.build))
      return c.json({error: "selected_build_changed"}, 409);
    if (requestInputDigest(expected) !== requestInputDigest(input))
      return c.json({error: "host_input_changed"}, 409);
    return c.json(await service.submit(requestId, hostId, input), 202);
  });
  return app;
}
export default createTestDispatchAdminApi();
