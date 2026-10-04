import {expect, test} from "bun:test";
import {routineAdmissionInput} from "./routine-admission.service";
import {hostStateSchema, type ReceivedTestHostState} from "./test-host-state.service";
import type {RoutineEnrollment} from "../types/routine-definition.types";
import {firmwareManifestSchema, type TestBuild} from "../types/test-build.types";
import {frameworkRequestInputSchema} from "../types/framework-request.types";

const revision = "a".repeat(40), sha256 = "b".repeat(64), now = Date.parse("2026-10-03T12:00:00Z");
const manifest = {url: "https://artifactscdn.mentraglass.com/exact/manifest.json", sha256, size: 100};
const build: TestBuild = {source: {channel: "dev", buildRunId: 10, publicationAttempt: 1}, platform: "android", title: "Selected build",
  headSha: revision, buildUrl: "https://github.com/example/run/10", createdAt: new Date(now).toISOString(), availability: "available",
  archive: {name: "app.apk", url: "https://artifactscdn.mentraglass.com/exact/app.apk", sha256, size: 100},
  receipt: {url: "https://artifactscdn.mentraglass.com/exact/receipt.json", sha256, size: 100}, manifest, manifestSha256: sha256};
const enrollment = (glasses = true): RoutineEnrollment => ({routineId: "arbitrary-camera", platform: "android", definitionRevision: revision,
  definitionSha256: sha256, definition: {id: "arbitrary-camera", title: "Camera", purpose: "Check camera", platforms: ["android"], entry: "sign-in", account: "none",
    requires: glasses ? ["camera"] : [], requirements: [], fixtures: [], ...(glasses ? {glasses: {models: ["mentra-live"]}} : {}),
    steps: [{id: "check", instruction: "Check", expected: "Observed"}], execution: {resourceKinds: glasses ? ["phone", "app", "glasses", "recorder"] : ["phone", "app", "recorder"]},
    source: {repository: "Mentra-Community/Mentra-Automated-Testing", revision, path: "routines/arbitrary-camera/routine.ts"}}});
const host = (glasses = true): ReceivedTestHostState => ({hostId: "mini", incarnation: "boot", incarnationGeneration: 1, sequence: 1,
  receivedAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), lanes: [{id: "phone-lane", platform: "android", dispatchMode: "automatic", state: "idle",
    resources: [{id: "phone", kind: "phone"}, {id: "app", kind: "app"}, {id: "recorder", kind: "recorder"}, ...(glasses ? [{id: "physical-live", kind: "glasses" as const}] : [])],
    ...(glasses ? {glasses: [{resourceId: "physical-live", deviceId: "live-cid", model: "mentra-live", capabilities: ["camera"]}]} : {})}]});
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

test("model, capability, inventory and manifest contradictions fail before producing admission input", () => {
  for (const glasses of [undefined, [], [{resourceId: "physical-live", deviceId: "live-cid", model: "g2", capabilities: ["camera"]}],
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
  expect(() => frameworkRequestInputSchema.parse({...glass, glassesReturn: {model: "mentra-live", manifest: {...manifest, sha256: "c".repeat(64)}}})).toThrow("Alternate glasses software");
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
  for (const second of [{...first, id: "mac-lane", glasses: [{...first.glasses![0]!, deviceId: "other-device"}]},
    {...first, id: "mac-lane", resources: first.resources.map(ref => ref.kind === "glasses" ? {...ref, id: "other-resource"} : ref), glasses: [{...first.glasses![0]!, resourceId: "other-resource"}]}])
    expect(() => hostStateSchema.parse({...base, lanes: [first, second]})).toThrow("Shared physical glasses");
  for (const lane of [{...first, glasses: undefined}, {...first, glasses: []}, {...first, glasses: [first.glasses![0]!, first.glasses![0]!]},
    {...first, glasses: [{...first.glasses![0]!, capabilities: ["camera", "camera"]}]}])
    expect(() => hostStateSchema.parse({...base, lanes: [lane]})).toThrow();
});
