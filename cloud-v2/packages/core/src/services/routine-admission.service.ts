import {z} from "zod";
import {frameworkIdentitySchema, frameworkRequestInputSchema} from "../types/framework-request.types";
import {type RoutineEnrollment} from "../types/routine-definition.types";
import {firmwareManifestSchema, selectedBuildInput, type GlassesSoftwareRef, type TestBuild} from "../types/test-build.types";
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
  binding: RoutineLaneBindings[RoutineEnrollment["platform"]], host: ReceivedTestHostState | null | undefined, now = Date.now(),
  options: {requireAutomatic?: boolean; minimumFrameworkVersion?: number} = {}) {
  if (!build || build.availability !== "available" || !build.archive || !build.receipt)
    throw new TestRunError(409, build?.reason ?? "No immutable artifact is available for this platform.");
  if (build.platform && build.platform !== definition.platform) throw new TestRunError(409, "Artifact platform differs from the routine definition.");
  if (!binding) throw new TestRunError(409, `No configured host/lane binding for ${definition.platform}.`);
  const lane = host?.lanes.find(lane => lane.id === binding.laneId && lane.platform === definition.platform);
  if (!host || host.hostId !== binding.hostId || !Number.isFinite(Date.parse(host.receivedAt)) || now - Date.parse(host.receivedAt) > 120_000)
    throw new TestRunError(409, `Configured ${definition.platform} host has no current observation.`);
  // The assigned host controller waits for lane repair/readiness; selection must retain this occurrence's request.
  if (!lane || options.requireAutomatic !== false && lane.dispatchMode !== "automatic")
    throw new TestRunError(409, `Configured ${definition.platform} automatic lane is unavailable.`);
  const execution = definition.definition.execution;
  if (!execution) throw new TestRunError(409, "The current definition has no execution resource metadata.");
  const glassesRequirement = definition.definition.glasses;
  let software: GlassesSoftwareRef | undefined;
  let startingSoftware: GlassesSoftwareRef | undefined;
  let glassesResourceId: string | undefined;
  if (glassesRequirement) {
    if (execution.resourceKinds.filter(kind => kind === "glasses").length !== 1)
      throw new TestRunError(409, "Glasses routine must declare its single glasses execution resource.");
    const offered = lane.glasses?.filter(value => glassesRequirement.models.includes(value.model)
      && (definition.definition.resourceRequirements.find(value => value.kind === "glasses")?.capabilities ?? []).every(capability => value.capabilities.includes(capability))) ?? [];
    if (offered.length !== 1) throw new TestRunError(409, "Configured lane has no unique compatible glasses model and provider capabilities.");
    glassesResourceId = offered[0]!.resourceId;
    if (offered[0]!.model !== "mentra-live") throw new TestRunError(409, "Selected glasses model has no supported software selection contract.");
    const manifest = firmwareManifestSchema.safeParse(build.manifest);
    if (!manifest.success || build.manifestSha256 !== manifest.data.sha256)
      throw new TestRunError(409, "Selected build has no matching immutable glasses manifest reference.");
    software = {model: "mentra-live", manifest: manifest.data};
    startingSoftware = glassesRequirement.startSoftware ?? software;
    if (startingSoftware.model !== offered[0]!.model)
      throw new TestRunError(409, "Starting software differs from the selected compatible glasses model.");
  } else if (execution.resourceKinds.includes("glasses"))
    throw new TestRunError(409, "Glasses execution requires an explicit routine model declaration.");
  const resources = execution.resourceKinds.map(kind => {
    const matches = lane.resources.filter(resource => resource.kind === kind);
    if (matches.length !== 1) throw new TestRunError(409, `Configured lane must bind exactly one ${kind} resource.`);
    if (kind === "glasses" && matches[0]!.id !== glassesResourceId)
      throw new TestRunError(409, "Compatible glasses inventory differs from its declared allocation resource.");
    const requiredCapabilities = definition.definition.resourceRequirements.find(value => value.kind === kind)!.capabilities;
    if (!requiredCapabilities.every(capability => matches[0]!.capabilities?.includes(capability)))
      throw new TestRunError(409, `Configured lane has no required ${kind} resource capabilities.`);
    const {capabilities: _, ...resource} = matches[0]!;
    return resource;
  });
  return frameworkRequestInputSchema.parse(JSON.parse(JSON.stringify({routineId: definition.routineId,
    definitionRevision: definition.definitionRevision, routineSource: definition.routineSource,
    ...(options.minimumFrameworkVersion !== undefined ? {minimumFrameworkVersion: options.minimumFrameworkVersion} : {}), platform: definition.platform, laneId: lane.id, resources,
    ...(execution.policy ? {policy: execution.policy} : {}), build: {...selectedBuildInput(build, definition.platform),
      ...(software ? {manifest: software.manifest, manifestSha256: software.manifest.sha256} : {})},
    ...(software ? {glassesStart: startingSoftware, glassesReturn: software} : {})})));
}
