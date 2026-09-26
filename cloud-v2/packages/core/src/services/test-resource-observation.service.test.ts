import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestResourceObservationApi } from "../api/internal/test-resource-observations.api";
import type { TestResourceObservation, TestResourceObservationPut, TestResourceProgress } from "../types/test-resource-observation.types";
import { testResourceObservationPutSchema } from "../types/test-resource-observation.types";
import { aliveObservation, noOwnerObservation, resourceProgress, retainedObservation } from "../types/test-resource-observation.examples";
import { TestResourceObservationService, type StoredTestResourceObservation, type TestResourceObservationRepository } from "./test-resource-observation.service";

/** In-memory compare-and-set store with the same contract as the Mongo repository. */
class MemoryObservations implements TestResourceObservationRepository {
  rows = new Map<string, StoredTestResourceObservation>();
  private key = (hostId: string, resourceKey: string) => JSON.stringify([hostId, resourceKey]);
  async get(hostId: string, resourceKey: string) { const row = this.rows.get(this.key(hostId, resourceKey)); return row ? structuredClone(row) : null; }
  async insert(value: StoredTestResourceObservation) {
    if (this.rows.has(this.key(value.hostId, value.resourceKey))) return false;
    this.rows.set(this.key(value.hostId, value.resourceKey), structuredClone(value)); return true;
  }
  async replace(expectedRevision: number, value: StoredTestResourceObservation) {
    if (this.rows.get(this.key(value.hostId, value.resourceKey))?.revision !== expectedRevision) return false;
    this.rows.set(this.key(value.hostId, value.resourceKey), structuredClone(value)); return true;
  }
}

const start = Date.parse("2026-09-26T10:00:00.000Z");
const retained = retainedObservation, alive = aliveObservation, noOwner = noOwnerObservation, progress = resourceProgress;
const discovery = "discovery-46e1b113-108e-4769-8678-3bd2b8d10777";
const put = (observation: TestResourceObservation, expectedRevision: number, extra: Partial<TestResourceObservationPut> = {}, hostId = "mini-03be",
  resourceKey = "shared"): TestResourceObservationPut => ({ schemaVersion: 1, hostId, resourceKey, expectedRevision, observation, ...extra });

describe("strict schema", () => {
  test("the retained mini-03be shape, an alive owner, a fresh no-owner snapshot and every unavailable form are accepted", () => {
    for (const observation of [retained(), alive("run-1"), noOwner(),
      { state: "unknown", reason: "owner-unverifiable", guard: { lock: "unreadable", reclaimMarker: "absent" }, fixture: { checked: false } },
      { state: "unknown", reason: "owner-unverifiable", guard: { lock: "present", reclaimMarker: "absent" }, owner: { valid: false }, fixture: { checked: false } },
      { state: "idle-prerequisite-unknown", reason: "fixture-record-malformed", guard: { lock: "absent", reclaimMarker: "absent" }, fixture: { checked: true, record: "malformed" } },
      { state: "idle-prerequisite-unknown", reason: "fixture-record-unreadable", guard: { lock: "absent", reclaimMarker: "absent" }, fixture: { checked: true, record: "unreadable" } },
      { state: "idle-prerequisite-blocked", reason: "recorded-fixture-uncommissioned", guard: { lock: "absent", reclaimMarker: "absent" },
        fixture: { checked: true, record: "valid", fixtureID: "03BE", status: "uncommissioned", lastRunID: "r" } },
      { state: "idle-prerequisites-unchecked", reason: "no-guard-fixture-not-supplied", guard: { lock: "absent", reclaimMarker: "absent" }, fixture: { checked: false } },
      { state: "unknown", reason: "reclaim-marker-unreadable", guard: { lock: "absent", reclaimMarker: "unknown" }, fixture: { checked: false } },
      { ...retained(), state: "ownership-changing", reason: "reclaim-marker-present", guard: { lock: "present", reclaimMarker: "present" } },
      { ...retained(), lastCheckpoint: { available: false } },
    ] as TestResourceObservation[]) expect(testResourceObservationPutSchema.safeParse(put(observation, 0)).success).toBe(true);
  });

  test("extra keys, freeform text, paths, tokens, unknown reasons and contradictory state are rejected", () => {
    const base = retained();
    const cases: unknown[] = [
      { ...put(base, 0), token: "secret" },
      { ...put(base, 0), receivedAt: "2026-09-26T10:00:00.000Z" },
      { ...put(base, 0), observation: { ...base, scopeCovers: "Shared app guard" } },
      { ...put(base, 0), observation: { ...base, caveats: ["free text"] } },
      { ...put(base, 0), observation: { ...base, message: "free text" } },
      { ...put(base, 0), observation: { ...base, lastCheckpoint: { ...base.lastCheckpoint, note: "Last recorded checkpoint only" } } },
      { ...put(base, 0), observation: { ...base, owner: { ...base.owner, token: "owner-token" } } },
      { ...put(base, 0), observation: { ...base, owner: { ...base.owner, reservation: { runID: "r", fixtureID: "f", runDirectory: "/Users/x/run" } } } },
      { ...put(base, 0), observation: { ...base, reason: "operator says it is fine" } },
      { ...put(base, 0), observation: { ...base, reason: "recorded-fixture-ready" } },
      { ...put(base, 0), observation: { ...base, env: { TEST_RUN_INGEST_TOKEN: "x" } } },
      // Reason/state/owner contradictions.
      { ...put(base, 0), observation: { ...base, state: "available-to-attempt" } },
      { ...put(base, 0), observation: { ...base, state: "busy", reason: "owner-process-alive" } },
      { ...put(base, 0), observation: { ...noOwner(), owner: base.owner } },
      { ...put(base, 0), observation: { ...base, owner: { ...base.owner!, retainedReason: undefined } } },
      { ...put(base, 0), observation: { ...base, lastCheckpoint: { ...base.lastCheckpoint!, runID: "another-run" } } },
      { ...put(base, 0), observation: { ...noOwner(), fixture: { ...noOwner().fixture, status: "busy" } } },
      // Identity.
      put(base, 0, {}, "mini 03be"), put(base, 0, {}, "mini-03be", "android-ABCDEF123456"), put(base, 0, {}, "mini-03be", "android-12"),
      put(base, 0, {}, "a".repeat(81)), { ...put(base, 0), schemaVersion: 2 }, { ...put(base, 0), expectedRevision: -1 },
      // Progress must belong to the observed owner's reservation.
      put(base, 0, { progress: progress("another-run", 1) }), put(noOwner(), 0, { progress: progress("r", 1) }),
      put(base, 0, { progress: { ...progress(discovery, 1), executionToken: "a".repeat(64) } as TestResourceProgress }),
    ];
    for (const value of cases) expect(testResourceObservationPutSchema.safeParse(value).success).toBe(false);
  });
});

describe("API", () => {
  const token = "t".repeat(40);
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.TEST_RUN_INGEST_TOKEN; process.env.TEST_RUN_INGEST_TOKEN = token; });
  afterEach(() => { if (saved === undefined) delete process.env.TEST_RUN_INGEST_TOKEN; else process.env.TEST_RUN_INGEST_TOKEN = saved; });
  const app = (store = new MemoryObservations()) => createTestResourceObservationApi(new TestResourceObservationService(store, () => new Date(start)));
  const send = (api: ReturnType<typeof app>, body: unknown, path = "/mini-03be/shared", auth = "Bearer " + token) =>
    api.request(path, { method: "PUT", headers: { authorization: auth, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

  test("only the existing ingestion capability can read or write; nothing is stored on refusal", async () => {
    const store = new MemoryObservations(), api = app(store);
    expect((await api.request("/mini-03be/shared")).status).toBe(401);
    expect((await send(api, put(retained(), 0), undefined, "Bearer " + "x".repeat(40))).status).toBe(401);
    delete process.env.TEST_RUN_INGEST_TOKEN;
    expect((await send(api, put(retained(), 0))).status).toBe(503);
    expect(store.rows.size).toBe(0);
  });

  test("GET reports revision 0 before any report; PUT stores Core time and no-store responses", async () => {
    const api = app();
    const empty = await api.request("/mini-03be/shared", { headers: { authorization: "Bearer " + token } });
    expect(empty.headers.get("cache-control")).toBe("no-store");
    expect(await empty.json()).toEqual({ schemaVersion: 1, hostId: "mini-03be", resourceKey: "shared", revision: 0, receivedAt: null, observation: null, progress: null });
    const written = await send(api, put(retained(), 0));
    expect(written.status).toBe(200);
    expect(await written.json()).toMatchObject({ revision: 1, receivedAt: new Date(start).toISOString(), applied: true, observation: retained() });
  });

  test("path identity, invalid JSON, unknown fields and oversize bodies are rejected", async () => {
    const api = app();
    expect((await send(api, put(retained(), 0), "/mini-other/shared")).status).toBe(400);
    expect((await send(api, put(retained(), 0), "/mini-03be/android-aaaaaaaaaaaa")).status).toBe(400);
    expect((await send(api, put(retained(), 0), "/mini-03be/..%2Fshared")).status).toBe(400);
    expect((await send(api, "{")).status).toBe(400);
    const extra = await send(api, { ...put(retained(), 0), notes: "private host path /Users/x" });
    expect(extra.status).toBe(400);
    expect(JSON.stringify(await extra.json())).not.toContain("/Users/x");
    expect((await send(api, { ...put(retained(), 0), pad: "x".repeat(17 * 1024) })).status).toBe(413);
  });
});

describe("compare-and-set and progress ordering", () => {
  let clock = start;
  const service = (store: MemoryObservations) => new TestResourceObservationService(store, () => new Date(clock));
  beforeEach(() => { clock = start; });

  test("an exact retry is idempotent without refreshing receivedAt; a different body at the same revision conflicts", async () => {
    const store = new MemoryObservations(), writer = service(store);
    const request = put(retained(), 0);
    const first = await writer.put("mini-03be", "shared", request);
    clock += 60_000;
    const retry = await writer.put("mini-03be", "shared", structuredClone(request));
    expect(retry).toEqual({ ...first, applied: false });
    await expect(writer.put("mini-03be", "shared", put(noOwner(), 0))).rejects.toMatchObject({ status: 409 });
    // A later write makes the old exact retry stale as well.
    await writer.put("mini-03be", "shared", put(noOwner(), 1));
    await expect(writer.put("mini-03be", "shared", request)).rejects.toMatchObject({ status: 409 });
    expect((await writer.get("mini-03be", "shared")).observation).toEqual(noOwner());
  });

  test("a stale in-flight write from an old owner cannot replace a newer owner's observation", async () => {
    const store = new MemoryObservations(), writer = service(store);
    await writer.put("mini-03be", "shared", put(alive("old-run", 100), 0));
    const oldRead = (await writer.get("mini-03be", "shared")).revision;
    const newRead = (await writer.get("mini-03be", "shared")).revision;
    await writer.put("mini-03be", "shared", put(alive("new-run", 200), newRead));
    // The old owner's snapshot (taken after its GET) must be discarded, not resent.
    await expect(writer.put("mini-03be", "shared", put(retained("old-run", 100), oldRead))).rejects.toMatchObject({ status: 409 });
    const current = await writer.get("mini-03be", "shared");
    expect(current.revision).toBe(2);
    expect(current.observation?.owner).toMatchObject({ pid: 200, reservation: { runID: "new-run" } });
  });

  test("same-run journal sequence is monotonic; a refresh without newer progress keeps the checkpoint", async () => {
    const store = new MemoryObservations(), writer = service(store);
    let revision = (await writer.put("mini-03be", "shared", put(alive("run-a"), 0, { progress: progress("run-a", 5) }))).revision;
    const firstReceipt = new Date(clock).toISOString();
    clock += 10_000;
    // Lower sequence: the fresh observation is accepted, the newer checkpoint is kept.
    let result = await writer.put("mini-03be", "shared", put(alive("run-a"), revision, { progress: progress("run-a", 3, "Older step") }));
    expect(result.progress).toEqual({ ...progress("run-a", 5), receivedAt: firstReceipt });
    revision = result.revision;
    // Same sequence with different content is a journal contradiction.
    await expect(writer.put("mini-03be", "shared", put(alive("run-a"), revision, { progress: progress("run-a", 5, "Rewritten") })))
      .rejects.toMatchObject({ status: 409 });
    // Same sequence and content, or no progress at all, keeps the original checkpoint and its receipt.
    result = await writer.put("mini-03be", "shared", put(alive("run-a"), revision, { progress: progress("run-a", 5) }));
    expect(result.progress?.receivedAt).toBe(firstReceipt);
    result = await writer.put("mini-03be", "shared", put(retained("run-a"), result.revision));
    expect(result.progress).toEqual({ ...progress("run-a", 5), receivedAt: firstReceipt });
    expect(result.observation?.state).toBe("retained-recovery-required");
    clock += 10_000;
    result = await writer.put("mini-03be", "shared", put(retained("run-a"), result.revision, { progress: progress("run-a", 6) }));
    expect(result.progress).toEqual({ ...progress("run-a", 6), receivedAt: new Date(clock).toISOString() });
  });

  test("a new owner or no owner never inherits the previous owner's progress", async () => {
    const store = new MemoryObservations(), writer = service(store);
    let result = await writer.put("mini-03be", "shared", put(alive("run-a"), 0, { progress: progress("run-a", 9) }));
    result = await writer.put("mini-03be", "shared", put(alive("run-b", 6000), result.revision));
    expect(result.progress).toBeNull();
    result = await writer.put("mini-03be", "shared", put(alive("run-b", 6000), result.revision, { progress: progress("run-b", 1) }));
    expect(result.progress?.sequence).toBe(1); // A lower sequence than run-a's is valid for a different run.
    result = await writer.put("mini-03be", "shared", put(noOwner(), result.revision));
    expect(result.progress).toBeNull();
    result = await writer.put("mini-03be", "shared", put(alive("run-b", 6000), result.revision));
    expect(result.progress).toBeNull();
  });

  test("dead PID and complete checkpoint are stored as reported; only a newer observation changes a retained hold", async () => {
    const store = new MemoryObservations(), writer = service(store);
    const { applied: _, ...record } = await writer.put("mini-03be", "shared", put(retained(), 0,
      { progress: { ...progress(discovery, 40), mode: "complete" } }));
    clock += 7 * 24 * 3_600_000;
    // No expiry, reclaim or completion inference: the retained report is unchanged a week later.
    const later = await writer.get("mini-03be", "shared");
    expect(later).toEqual(record);
    expect(later.observation?.state).toBe("retained-recovery-required");
  });

  test("hosts and Android phones are independent resources; the same fixture alias never correlates them", async () => {
    const store = new MemoryObservations(), writer = service(store);
    await writer.put("mini-03be", "shared", put(retained("run-a"), 0));
    await writer.put("mini-7c1d", "shared", put(noOwner(), 0, {}, "mini-7c1d"));
    await writer.put("mini-03be", "android-0123456789ab", put(alive("phone-run"), 0, {}, "mini-03be", "android-0123456789ab"));
    expect((await writer.get("mini-03be", "shared")).observation?.state).toBe("retained-recovery-required");
    expect((await writer.get("mini-7c1d", "shared")).observation?.state).toBe("available-to-attempt");
    expect((await writer.get("mini-03be", "android-0123456789ab")).observation?.state).toBe("busy");
    expect((await writer.get("mini-7c1d", "android-0123456789ab")).revision).toBe(0);
    expect([...store.rows.values()].map(row => row.revision)).toEqual([1, 1, 1]);
  });
});
