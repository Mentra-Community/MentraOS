import {testRoutineSource} from "../testing/framework-fixtures"
import {expect, test} from "bun:test";
import {routineAdmissionInput} from "./routine-admission.service";
import {hostStateSchema, type ReceivedTestHostState} from "./test-host-state.service";
import {routineEnrollmentSchema, type RoutineEnrollment} from "../types/routine-definition.types";
import {firmwareManifestSchema, type TestBuild} from "../types/test-build.types";
import {frameworkRequestInputSchema} from "../types/framework-request.types";

const revision = "a".repeat(40), sha256 = "b".repeat(64), now = Date.parse("2026-10-03T12:00:00Z");
const manifest = {url: "https://artifactscdn.mentraglass.com/exact/manifest.json", sha256, size: 100};
const build: TestBuild = {source: {channel: "dev", buildRunId: 10, publicationAttempt: 1}, platform: "android", title: "Selected build",
  headSha: revision, buildUrl: "https://github.com/example/run/10", createdAt: new Date(now).toISOString(), availability: "available",
  archive: {name: "app.apk", url: "https://artifactscdn.mentraglass.com/exact/app.apk", sha256, size: 100},
  receipt: {url: "https://artifactscdn.mentraglass.com/exact/receipt.json", sha256, size: 100}, manifest, manifestSha256: sha256};
const enrollment = (glasses = true): RoutineEnrollment => ({
  routineId: "arbitrary-camera",
  platform: "android",
  definitionRevision: revision,
  definitionSha256: sha256,
  routineSource: testRoutineSource(revision),
  definition: {
    minimumRoutineApiVersion: 1,
    id: "arbitrary-camera",
    title: "Camera",
    purpose: "Check camera",
    platforms: ["android"],
    entry: "sign-in",
    account: "none",
    resourceRequirements: (glasses ? ["phone", "app", "glasses", "recorder"] : ["phone", "app", "recorder"]).map(kind => ({kind: kind as "phone" | "app" | "glasses" | "recorder", capabilities: kind === "glasses" ? ["connection"] : []})),
    requirements: [],
    fixtures: [],
    ...(glasses ? {glasses: {models: ["mentra-live"]}} : {}),
    steps: [{id: "check", instruction: "Check", expected: "Observed"}],
    execution: {resourceKinds: glasses ? ["phone", "app", "glasses", "recorder"] : ["phone", "app", "recorder"]},
    source: {repository: "Mentra-Community/Mentra-Automated-Testing", revision, path: "routines/arbitrary-camera/routine.ts"},
  },
})
const host = (glasses = true): ReceivedTestHostState => ({hostId: "mini", incarnation: "boot", incarnationGeneration: 1, sequence: 1,
  receivedAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), lanes: [{id: "phone-lane", platform: "android", dispatchMode: "automatic", state: "idle",
    resources: [{id: "phone", kind: "phone"}, {id: "app", kind: "app"}, {id: "recorder", kind: "recorder"}, ...(glasses ? [{id: "physical-live", kind: "glasses" as const, capabilities: ["connection"]}] : [])],
    ...(glasses ? {glasses: [{resourceId: "physical-live", deviceId: "live-cid", model: "mentra-live", capabilities: ["connection"]}]} : {})}]});
const select = (definition = enrollment(), selected = build, observed = host()) => routineAdmissionInput(definition, selected,
  {hostId: "mini", laneId: "phone-lane"}, observed, now);

test("glasses dispatch matches declared model/capability and freezes exact build manifest for start and return", () => {
  const input = select();
  expect(input.resources.find(ref => ref.kind === "glasses")?.id).toBe("physical-live");
  expect(input.glassesStart).toEqual({model: "mentra-live", manifest});
  expect(input.glassesReturn).toEqual(input.glassesStart);
  expect(input.build.manifestSha256).toBe(sha256);
  expect(select(enrollment(), build, {...host(), lanes: [{...host().lanes[0]!, state: "offline"}]}).glassesStart).toEqual(input.glassesStart);
});

test('a recording witness without recognition cannot admit a speech recognition routine', () => {
  const definition = enrollment(false);
  definition.definition.resourceRequirements.push({kind: 'audio', capabilities: ['witness', 'recognition']});
  definition.definition.execution!.resourceKinds.push('audio');
  const observed = host(false), lane = observed.lanes[0]!;
  lane.resources.push({id: 'audio', kind: 'audio', capabilities: ['speech', 'witness', 'synthesis']});
  expect(() => select(definition, build, observed)).toThrow('required audio resource capabilities');
  lane.resources.find(resource => resource.kind === 'audio')!.capabilities!.push('recognition');
  expect(select(definition, build, observed).resources).toContainEqual({id: 'audio', kind: 'audio'});
});

test("model, capability, inventory and manifest contradictions fail before producing admission input", () => {
  for (const glasses of [undefined, [], [{resourceId: "physical-live", deviceId: "live-cid", model: "g2", capabilities: ["connection"]}],
    [{resourceId: "physical-live", deviceId: "live-cid", model: "mentra-live", capabilities: []}]])
    expect(() => select(enrollment(), build, {...host(), lanes: [{...host().lanes[0]!, glasses}]})).toThrow("compatible glasses");
  for (const selected of [{...build, manifest: undefined}, {...build, manifestSha256: "c".repeat(64)},
    {...build, manifest: {...manifest, url: "http://example.invalid/manifest"}}])
    expect(() => select(enrollment(), selected)).toThrow("immutable glasses manifest");
  expect(() => select({...enrollment(), definition: {...enrollment().definition, glasses: undefined}})).toThrow("explicit routine model");
  expect(() => select(enrollment(), build, {...host(), lanes: [{...host().lanes[0]!,
    glasses: [{...host().lanes[0]!.glasses![0]!, resourceId: "other-resource"}]}]})).toThrow("allocation resource");
});

test("phone-only request retains its previous shape and rejects injected software or alternate return", () => {
  const plain = select(enrollment(false), build, host(false));
  expect(plain).not.toHaveProperty("glassesStart"); expect(plain).not.toHaveProperty("glassesReturn");
  expect(plain.build).not.toHaveProperty("manifest"); expect(plain.build).not.toHaveProperty("manifestSha256");
  expect(() => frameworkRequestInputSchema.parse({...plain, glassesStart: {model: "mentra-live", manifest}, glassesReturn: {model: "mentra-live", manifest}})).toThrow("Selected glasses resource");
  const glass = select();
  expect(() => frameworkRequestInputSchema.parse({...glass, glassesReturn: {model: "mentra-live", manifest: {...manifest, sha256: "c".repeat(64)}}})).toThrow("selected build manifest");
  expect(() => frameworkRequestInputSchema.parse({...glass, glassesStart: {model: "mentra-live", manifest: {...manifest, size: 101}}, glassesReturn: {model: "mentra-live", manifest: {...manifest, size: 101}}})).toThrow("selected build manifest");
});

test("manifest validation refuses malformed or unbound references as validation errors", () => {
  for (const url of ["not-a-url", "https://user:password@example.invalid/manifest.json", "https://example.invalid/manifest.json#newest", "https://example.invalid/manifest.json#", "http://example.invalid/manifest.json"])
    expect(firmwareManifestSchema.safeParse({...manifest, url}).success).toBe(false);
  const input = select();
  for (const changed of [{...input, glassesReturn: undefined}, {...input, build: {...input.build, manifestSha256: "c".repeat(64)}}])
    expect(frameworkRequestInputSchema.safeParse(changed).success).toBe(false);
});

test("unsupported compatible models and ambiguous physical selections retain precise refusal", () => {
  const definition = {...enrollment(), definition: {...enrollment().definition, glasses: {models: ["g2"]}}};
  const observed = {...host(), lanes: [{...host().lanes[0]!, glasses: [{...host().lanes[0]!.glasses![0]!, model: "g2"}]}]};
  expect(() => select(definition, build, observed)).toThrow("no supported software selection contract");
  expect(() => select(enrollment(), build, {...host(), lanes: [{...host().lanes[0]!,
    glasses: [...host().lanes[0]!.glasses!, {...host().lanes[0]!.glasses![0]!, resourceId: "another-live", deviceId: "another-product"}]}]}))
    .toThrow("no unique compatible glasses");
});

test("physical inventory maps one product to one resource across lanes while capabilities remain lane-specific", () => {
  const first = host().lanes[0]!;
  const {receivedAt, ...base} = host();
  const snapshot = {...base, lanes: [first, {...first, id: "mac-lane", platform: "ios-on-mac", glasses: [{...first.glasses![0]!, capabilities: []}]}]};
  expect(hostStateSchema.parse(snapshot).lanes).toHaveLength(2);
  for (const second of [
    {...first, id: "mac-lane", glasses: [{...first.glasses![0]!, deviceId: "other-device"}]},
    {
      ...first,
      id: "mac-lane",
      resources: first.resources.map((ref) => (ref.kind === "glasses" ? {...ref, id: "other-resource"} : ref)),
      glasses: [{...first.glasses![0]!, resourceId: "other-resource"}],
    },
  ])
    expect(() => hostStateSchema.parse({...base, lanes: [first, second]})).toThrow("Shared physical glasses");
  for (const lane of [{...first, glasses: undefined}, {...first, glasses: []}, {...first, glasses: [first.glasses![0]!, first.glasses![0]!]},
    {...first, glasses: [{...first.glasses![0]!, capabilities: ["camera", "camera"]}]}])
    expect(() => hostStateSchema.parse({...base, lanes: [lane]})).toThrow();
})

test("enrollment and dispatch bind routine-declared starting software while preserving the selected build return", () => {
  const startSoftware = {model: "mentra-live" as const, manifest: {...manifest, url: "https://artifactscdn.mentraglass.com/reset/manifest.json", sha256: "c".repeat(64)}};
  const declared = routineEnrollmentSchema.parse({...enrollment(), definition: {...enrollment().definition,
    glasses: {models: ["mentra-live"], startSoftware}}});
  const input = select(declared);
  expect(input.glassesStart).toEqual(startSoftware);
  expect(input.glassesReturn).toEqual({model: "mentra-live", manifest});
  expect(input.build.manifest).toEqual(manifest);
  expect(frameworkRequestInputSchema.parse(input).glassesStart).toEqual(startSoftware);
  expect(() => frameworkRequestInputSchema.parse({...input, glassesReturn: startSoftware})).toThrow("selected build manifest");
  expect(() => routineEnrollmentSchema.parse({...declared, definition: {...declared.definition,
    glasses: {models: ["g2"], startSoftware}}})).toThrow("accepted glasses model");
  expect(() => routineEnrollmentSchema.parse({...declared, definition: {...declared.definition,
    glasses: {models: ["mentra-live"], startSoftware: {...startSoftware, manifest: {...manifest, url: "file:///private/reset.json"}}}}})).toThrow();
});

test("host fixture requirements do not become physical glasses capabilities on either platform", () => {
  for (const platform of ["android", "ios-on-mac"] as const) {
    const definition = enrollment();
    definition.platform = platform;
    definition.definition.platforms = [platform];
    definition.definition.resourceRequirements.push({kind: "fixture-data", capabilities: []});
    definition.definition.fixtures = [{provider: "recorded-media", description: "Owned recorded media fixture"}];
    definition.definition.execution!.resourceKinds.push("fixture-data");
    const observed = host(), lane = observed.lanes[0]!;
    lane.platform = platform;
    lane.resources.push({id: "recorded-media", kind: "fixture-data"});
    lane.routineAvailability = [{routineId: definition.routineId, definitionRevision: revision, available: true}];
    const input = select(definition, {...build, platform}, observed);
    expect(input.resources).toContainEqual({id: "recorded-media", kind: "fixture-data"});
    expect(input.resources).toContainEqual({id: "physical-live", kind: "glasses"});
    expect(input.glassesReturn).toEqual({model: "mentra-live", manifest});
    expect(lane.glasses![0]!.capabilities).toEqual(["connection"]);
    expect(definition.definition.resourceRequirements.find(value => value.kind === "fixture-data")).toEqual({kind: "fixture-data", capabilities: []});
    lane.resources = lane.resources.filter(value => value.kind !== "fixture-data");
    expect(() => select(definition, {...build, platform}, observed)).toThrow("exactly one fixture-data resource");
    lane.resources.push({id: "recorded-media", kind: "fixture-data"});
    lane.routineAvailability[0]!.available = false;
    // Waiting jobs keep their selected immutable source while start preparation refreshes actual availability.
    expect(select(definition, {...build, platform}, observed).routineSource).toEqual(definition.routineSource)
  }
})

test("mixed host audio and external-window requirements retain their exact resource bindings", () => {
  const definition = enrollment(); definition.definition.resourceRequirements.push({kind: "audio", capabilities: []}, {kind: "fixture-data", capabilities: []});
  definition.definition.execution!.resourceKinds.push("audio", "fixture-data");
  const observed = host(), lane = observed.lanes[0]!;
  lane.resources.push({id: "loopback", kind: "audio"}, {id: "external-player", kind: "fixture-data"});
  lane.routineAvailability = [{routineId: definition.routineId, definitionRevision: revision, available: true}];
  const input = select(definition, build, observed);
  expect(input.resources).toContainEqual({id: "loopback", kind: "audio"});
  expect(input.resources).toContainEqual({id: "external-player", kind: "fixture-data"});
  lane.resources = lane.resources.filter(value => value.kind !== "audio");
  expect(() => select(definition, build, observed)).toThrow("exactly one audio resource");
});

test("projecting known host providers preserves missing real and unknown glasses capability refusals", () => {
  for (const capability of ["connection", "unimplemented-glasses-feature"]) {
    const definition = enrollment(); definition.definition.resourceRequirements.find(value => value.kind === "glasses")!.capabilities = [capability];
    definition.definition.resourceRequirements.push({kind: "fixture-data", capabilities: []});
    definition.definition.execution!.resourceKinds.push("fixture-data");
    const observed = host(), lane = observed.lanes[0]!;
    lane.resources.push({id: "media", kind: "fixture-data"});
    lane.glasses![0]!.capabilities = [];
    expect(() => select(definition, build, observed)).toThrow("compatible glasses");
  }
});

test("host preparation independently rechecks generic resource capabilities before concrete allocation", () => {
  const original = enrollment(false), definition: RoutineEnrollment = {...original, definition: {...original.definition,
    execution: {resourceKinds: ["phone", "app", "recorder", "network"]},
    resourceRequirements: [...original.definition.resourceRequirements, {kind: "network" as const, capabilities: ["independent-uplink"]}]}};
  const lane = host(false).lanes[0]!, network = {id: "network-uplink", kind: "network" as const, capabilities: ["independent-uplink"]};
  const offered = {...host(false), lanes: [{...lane, resources: [...lane.resources, network]}]};
  const input = select(definition, build, offered);
  expect(input.resources.find(resource => resource.kind === "network")).toEqual({id: "network-uplink", kind: "network"});
  expect(() => select(definition, build, {...offered, lanes: [{...offered.lanes[0]!,
    resources: [...lane.resources, {...network, capabilities: []}]}]})).toThrow("resource capabilities");
});

test('typed phone capabilities are enforced before admission without becoming glasses requirements', () => {
  const enrolled = enrollment(false), offered = host(false)
  enrolled.definition.resourceRequirements.find(resource => resource.kind === 'phone')!.capabilities = ['bluetooth-toggle', 'dialogs']
  expect(() => routineAdmissionInput(enrolled, build, {hostId:'mini',laneId:'phone-lane'}, offered, now)).toThrow('capabilities')
  offered.lanes[0]!.resources.find(resource => resource.kind === 'phone')!.capabilities = ['bluetooth-toggle', 'dialogs']
  const input = routineAdmissionInput(enrolled, build, {hostId:'mini',laneId:'phone-lane'}, offered, now)
  expect(input.resources.map(resource => resource.kind)).toEqual(['phone','app','recorder'])
  expect(input.glassesStart).toBeUndefined()
})
