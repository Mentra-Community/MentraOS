import {createHash} from "node:crypto";
import {expect, test} from "bun:test";
import {StateRepairDiagnosticsService, STATE_REPAIR_DIAGNOSTIC_BYTES, STATE_REPAIR_FAILURE_BYTES} from "./state-repair-diagnostics.service";
import {requestInputDigest} from "./test-request.service";

const payload = {ownerId: "fixer:execution-1", generation: 3, source: "state-repair" as const,
  originalFailure: {actionId: "boundary-cleanup", message: "Owned test app remained"},
  entries: [{timestamp: 0, level: "info", source: "harness-state-repair", message: '{"observed":"owned app"}'}], key: "native-diagnostic-1"};
const envelope = (value = payload) => ({...value, payloadSha256: requestInputDigest(value)});

test("repair attachment custody is exact, retryable and independent of the original run manifest", async () => {
  const bodies = new Map<string, string>(); let ensured: unknown, readyCalls = 0;
  const service = new StateRepairDiagnosticsService({
    async ensure(host, interruption, failure) {ensured = {host, interruption, failure}; return {reportId: "rep_TEST", mentraUserId: "automation:state-repair"};},
    async attach(input, retry) {
      const bytes = Buffer.from(JSON.stringify({entries: input.entries})), key = retry!.key;
      if (bodies.has(key) && bodies.get(key) !== bytes.toString()) throw new Error("Attachment reservation differs");
      bodies.set(key, bytes.toString());
      return {stored: 1, receipt: {artifactId: "art_TEST", sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength}};
    },
    async ready() {readyCalls++; return readyCalls === 1 ? "ready" : null;},
  });
  const first = await service.publish("mini", "repair:mini-mac:1", envelope());
  expect(await service.publish("mini", "repair:mini-mac:1", envelope())).toEqual(first);
  expect(ensured).toEqual({host: "mini", interruption: "repair:mini-mac:1", failure: payload.originalFailure});
  expect(first).toMatchObject({hostId: "mini", interruptionId: "repair:mini-mac:1", ownerId: payload.ownerId,
    generation: 3, reportId: "rep_TEST", payloadSha256: requestInputDigest(payload)});
  expect(bodies.size).toBe(1);
  const reordered = {...payload, entries: [{message: payload.entries[0]!.message, source: "harness-state-repair", level: "info", timestamp: 0}]};
  expect(await service.publish("mini", "repair:mini-mac:1", envelope(reordered))).toEqual(first);
  await expect(service.publish("mini", "repair:mini-mac:1", envelope({...payload, entries: [{...payload.entries[0]!, message: "changed"}]})))
    .rejects.toThrow("reservation differs");
});

test("invalid identity, changed digest and oversized diagnostics fail before incident creation", async () => {
  let called = false;
  const service = new StateRepairDiagnosticsService({
    async ensure() {called = true; throw new Error("Must not create an incident");},
    async attach() {throw new Error("Must not attach");}, async ready() {throw new Error("Must not complete");},
  });
  await expect(service.publish("mini", "../foreign", envelope())).rejects.toThrow("identity");
  await expect(service.publish("mini", "repair:1", {...envelope(), payloadSha256: "0".repeat(64)})).rejects.toThrow("digest");
  const {originalFailure: _, ...missingFailure} = envelope();
  await expect(service.publish("mini", "repair:1", missingFailure)).rejects.toThrow("Invalid repair diagnostics");
  await expect(service.publish("mini", "repair:1", {...envelope(), originalFailure: undefined})).rejects.toThrow("finite JSON");
  const oversizedFailure = {...payload, originalFailure: {...payload.originalFailure, message: "x".repeat(STATE_REPAIR_FAILURE_BYTES)}};
  await expect(service.publish("mini", "repair:1", envelope(oversizedFailure))).rejects.toThrow("failure summary exceeds");
  const oversized = {...payload, entries: [{timestamp: 0, level: "info", source: "harness-state-repair", message: "x".repeat(STATE_REPAIR_DIAGNOSTIC_BYTES)}]};
  await expect(service.publish("mini", "repair:1", envelope(oversized))).rejects.toThrow("bound");
  expect(called).toBe(false);
});

test("corrupt storage acknowledgement never authorizes local disposal or report completion", async () => {
  let marked = false;
  const service = new StateRepairDiagnosticsService({
    async ensure() {return {reportId: "rep_TEST", mentraUserId: "automation:state-repair"};},
    async attach() {return {stored: 1, receipt: {artifactId: "art_TEST", sha256: "0".repeat(64), sizeBytes: 1}};},
    async ready() {marked = true; return "ready";},
  });
  await expect(service.publish("mini", "repair:1", envelope())).rejects.toThrow("acknowledgement differs");
  expect(marked).toBe(false);
});
