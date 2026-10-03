import {z} from "zod";
import {frameworkIdentitySchema, frameworkRequestInputSchema} from "../types/framework-request.types";
import type {RoutineEnrollment} from "../types/routine-definition.types";
import {selectedBuildInput, type TestBuild} from "../types/test-build.types";
import type {ReceivedTestHostState} from "./test-host-state.service";
import {TestRunError} from "./test-result-error";

const laneBinding = z.object({hostId: frameworkIdentitySchema, laneId: frameworkIdentitySchema}).strict();
export const routineLaneBindingsSchema = z.object({android: laneBinding.optional(), "ios-on-mac": laneBinding.optional()}).strict();
export type RoutineLaneBindings = z.infer<typeof routineLaneBindingsSchema>;
export function configuredRoutineLanes(): RoutineLaneBindings {
  const raw = process.env.NIGHTLY_ROUTINE_LANES;
  if (!raw) return {};
  try {return routineLaneBindingsSchema.parse(JSON.parse(raw));}
  catch {throw new TestRunError(503, "Routine platform lane configuration is invalid");}
}
/** Shared by catalog nightlies and exact-source callers. Platform bindings never depend on routine names. */
export function routineAdmissionInput(definition: RoutineEnrollment, build: TestBuild | null | undefined,
  binding: RoutineLaneBindings[RoutineEnrollment["platform"]], host: ReceivedTestHostState | null | undefined, now = Date.now()) {
  if (!build || build.availability !== "available" || !build.archive || !build.receipt)
    throw new TestRunError(409, build?.reason ?? "No immutable artifact is available for this platform.");
  if (build.platform && build.platform !== definition.platform) throw new TestRunError(409, "Artifact platform differs from the routine definition.");
  if (!binding) throw new TestRunError(409, `No configured host/lane binding for ${definition.platform}.`);
  const lane = host?.lanes.find(lane => lane.id === binding.laneId && lane.platform === definition.platform);
  if (!host || host.hostId !== binding.hostId || !Number.isFinite(Date.parse(host.receivedAt)) || now - Date.parse(host.receivedAt) > 120_000)
    throw new TestRunError(409, `Configured ${definition.platform} host has no current observation.`);
  if (!lane || lane.dispatchMode !== "automatic" || ["in-repair", "out-of-service", "offline"].includes(lane.state))
    throw new TestRunError(409, `Configured ${definition.platform} automatic lane is unavailable.`);
  const execution = definition.definition.execution;
  if (!execution) throw new TestRunError(409, "The current definition has no execution resource metadata.");
  const resources = execution.resourceKinds.map(kind => {
    const matches = lane.resources.filter(resource => resource.kind === kind);
    if (matches.length !== 1) throw new TestRunError(409, `Configured lane must bind exactly one ${kind} resource.`);
    return matches[0]!;
  });
  return frameworkRequestInputSchema.parse(JSON.parse(JSON.stringify({routineId: definition.routineId,
    definitionRevision: definition.definitionRevision, platform: definition.platform, laneId: lane.id, resources,
    ...(execution.policy ? {policy: execution.policy} : {}), build: selectedBuildInput(build, definition.platform)})));
}
