import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { createTestHostObservationsApi } from "../api/internal/test-host-observations.api";
import { createTestRunAdminApi } from "../api/admin/test-runs.api";
import { principalAuth } from "../api/middleware/principal.middleware";
import { HOST_FRESH_MS, HOST_SAMPLE_LIMIT, hostIsFresh, testHostSampleSchema, type TestHostSample } from "../types/test-host-health.types";
import type { AppEnv } from "../types/hono.types";
import { TestHostHealthService, type StoredHostSample, type TestHostHealthRepository } from "./test-host-health.service";

const start = Date.parse("2026-09-29T00:00:00Z");
const sample = (at = start, extra: Partial<TestHostSample> = {}): TestHostSample => ({ schemaVersion: 1, hostId: "mini-1", sampleId: randomUUID(),
  sampledAt: new Date(at).toISOString(), freeBytes: 19 * 1024 ** 3, components: [
    { component: "general-worker", enabled: true, state: "running", reason: "none" },
    { component: "triage-worker", enabled: null, state: "unknown", reason: "not-configured" },
    { component: "disk-cleanup", enabled: true, state: "blocked", reason: "permission-denied" },
  ], cleanupEvents: [], ...extra });
class MemoryHealth implements TestHostHealthRepository {
  rows = new Map<string, StoredHostSample>(); latest = new Map<string, StoredHostSample>(); requestedLimit = 0;
  async insert(row: StoredHostSample) { const key = row.hostId + row.sampleId; if (this.rows.has(key)) return false; this.rows.set(key, structuredClone(row)); return true; }
  async get(hostId: string, sampleId: string) { return this.rows.get(hostId + sampleId) ?? null; }
  async updateLatest(row: StoredHostSample) { const old = this.latest.get(row.hostId);
    if (!old || row.sampledAt > old.sampledAt || +row.sampledAt === +old.sampledAt && row.sampleId >= old.sampleId) this.latest.set(row.hostId, structuredClone(row)); }
  async hosts(limit: number) { return [...this.latest.values()].sort((a, b) => a.hostId.localeCompare(b.hostId)).slice(0, limit); }
  async history(hostId: string, from: Date, to: Date, limit: number) { this.requestedLimit = limit; return [...this.rows.values()]
    .filter(row => row.hostId === hostId && row.sampledAt >= from && row.sampledAt <= to)
    .sort((a, b) => +b.sampledAt - +a.sampledAt || b.sampleId.localeCompare(a.sampleId)).slice(0, limit).map(row => row.payload); }
}
describe("passive host health", () => {
  test("memory shares immutable samples, latest ordering and disk history without backfilling old observations", async () => {
    const repo = new MemoryHealth(); let now = start;
    const service = new TestHostHealthService(repo, () => new Date(now)), old = sample();
    await service.ingest(old); now += 60_000;
    const memory = { totalBytes: 8 * 1024 ** 3, usedBytes: 5 * 1024 ** 3, compressedBytes: 1024 ** 3,
      swapUsedBytes: 4 * 1024 ** 3, pressureFreePercent: 61, pressure: "normal" as const };
    const current = sample(now, { memory }); await service.ingest(current);
    const first = (await service.list()).hosts[0]; expect(first.memory).toEqual(memory);
    now += 60_000; await service.ingest(structuredClone(current));
    await service.ingest(sample(start - 60_000, { memory: { ...memory, pressure: "critical" } }));
    expect((await service.list()).hosts[0]).toEqual(first);
    await expect(service.ingest({ ...current, memory: { ...memory, swapUsedBytes: 0 } })).rejects.toMatchObject({ status: 409 });
    const history = await service.history("mini-1", "1");
    expect(history.points.at(-1)).toMatchObject({ sampleId: current.sampleId, freeBytes: current.freeBytes, memory });
    expect(history.points.find(point => point.sampleId === old.sampleId)).not.toHaveProperty("memory");
    now += 60_000; await service.ingest(sample(now, { memory: null, freeBytes: null }));
    expect((await service.list()).hosts[0].memory).toBeNull();
    expect((await service.history("mini-1", "1")).points.at(-1)).toMatchObject({ memory: null, freeBytes: null });
  });
  test("memory reports admit independent partial readings and reject impossible/private metrics", () => {
    const memory = { totalBytes: 8 * 1024 ** 3, usedBytes: null, compressedBytes: null, swapUsedBytes: 12 * 1024 ** 3,
      pressureFreePercent: null, pressure: null };
    expect(testHostSampleSchema.safeParse(sample(start, { memory })).success).toBe(true);
    for (const change of [{ totalBytes: 0 }, { usedBytes: -1 }, { compressedBytes: Number.MAX_SAFE_INTEGER + 1 },
      { usedBytes: 9 * 1024 ** 3 }, { compressedBytes: 9 * 1024 ** 3 }, { pressureFreePercent: 101 },
      { pressureFreePercent: Number.NaN }, { pressure: "low-free-pages" }, { raw: "private vm output" }])
      expect(testHostSampleSchema.safeParse(sample(start, { memory: { ...memory, ...change } as any })).success).toBe(false);
    expect(testHostSampleSchema.safeParse(sample(start, { memory: { ...memory, usedBytes: 7 * 1024 ** 3, pressure: "normal", pressureFreePercent: 61 } })).success).toBe(true);
  });
  test("real sample identity is immutable and replay/delayed delivery cannot refresh the last observation", async () => {
    const repo = new MemoryHealth(); let now = start;
    const service = new TestHostHealthService(repo, () => new Date(now)), original = sample();
    const first = await service.ingest(original); now += 60_000;
    expect(await service.ingest(structuredClone(original))).toEqual({ ...first, created: false });
    expect((await service.list()).hosts[0].receivedAt).toBe(new Date(start).toISOString());
    await expect(service.ingest({ ...original, freeBytes: 1 })).rejects.toMatchObject({ status: 409 });
    const recent = sample(now); await service.ingest(recent);
    now += 60_000; await service.ingest(sample(start - 60_000));
    expect((await service.list()).hosts[0].sampleId).toBe(recent.sampleId);
    expect((await service.history("mini-1", "1")).points.map(point => point.sampledAt)).toEqual([
      new Date(start - 60_000).toISOString(), original.sampledAt, recent.sampledAt,
    ]);
    expect(repo.requestedLimit).toBe(HOST_SAMPLE_LIMIT + 1);
    expect((await service.history("mini-1", "1")).thresholdBytes).toBe(5 * 1024 ** 3);
  });
  test("future/expired samples and invalid windows are refused; stale disk never becomes a zero sample", async () => {
    const repo = new MemoryHealth(), service = new TestHostHealthService(repo, () => new Date(start));
    for (const at of [start + 5_001, start - 7 * 86_400_000 - 1]) await expect(service.ingest(sample(at))).rejects.toMatchObject({ status: 400 });
    expect(repo.rows.size).toBe(0);
    await service.ingest(sample(start, { freeBytes: null }));
    expect((await service.history("mini-1", "7")).points[0].freeBytes).toBeNull();
    for (const days of ["2", "0", "100", "oops"]) await expect(service.history("mini-1", days)).rejects.toMatchObject({ status: 400 });
    await expect(service.history("../private", "1")).rejects.toMatchObject({ status: 400 });
    const host = (await service.list()).hosts[0];
    expect(hostIsFresh(host, start)).toBe(true);
    expect(hostIsFresh(host, start + HOST_FRESH_MS + 1)).toBe(false);
    expect(hostIsFresh({ ...host, receivedAt: new Date(start + HOST_FRESH_MS + 1).toISOString() }, start + HOST_FRESH_MS + 1)).toBe(false);
  });
  test("only explicit configuration/disposition supports missing/paused services; private fields cannot enter public reports", () => {
    const base = sample();
    const invalid = [
      { ...base, secret: "private" }, { ...base, freeBytes: -1 }, { ...base, freeBytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, components: [{ ...base.components[0], command: "/private/worker" }] },
      { ...base, components: [base.components[0], base.components[0]] },
      ...[null, false].map(enabled => ({ ...base, components: [{ component: "triage-worker", enabled, state: "blocked", reason: "process-missing" }] })),
      { ...base, components: [{ component: "general-worker", enabled: true, state: "stopped", reason: "process-missing" }] },
      { ...base, components: [{ component: "general-worker", enabled: true, state: "stopped", reason: "disabled" }] },
      { ...base, components: [{ component: "triage-worker", enabled: true, state: "scheduled", reason: "none" }] },
    ];
    expect(testHostSampleSchema.safeParse(base).success).toBe(true);
    expect(testHostSampleSchema.safeParse({ ...base, components: [{ component: "disk-cleanup", enabled: true, state: "blocked", reason: "budget-limited" }] }).success).toBe(true);
    for (const value of invalid) expect(testHostSampleSchema.safeParse(value).success).toBe(false);
    expect(testHostSampleSchema.safeParse({ ...base, components: [{ component: "general-worker", enabled: true, state: "stopped", reason: "operator-drained" }] }).success).toBe(true);
  });
  test("refused scheduled receipts remain separate from manual success; untimed after-value is never a disk point", async () => {
    const repo = new MemoryHealth(), service = new TestHostHealthService(repo, () => new Date(start));
    const event: TestHostSample["cleanupEvents"][number] = { receiptId: "scheduled-1", receiptSha256: "a".repeat(64), origin: "scheduled",
      startedAt: new Date(start - 60_000).toISOString(), finishedAt: null, freeBefore: 21 * 1024 ** 3, freeAfter: 19 * 1024 ** 3,
      freeAfterSampledAt: null, status: "refused", reason: "permission-denied", removedCount: 0 };
    await service.ingest(sample(start, { cleanupEvents: [event, { ...event, receiptId: "manual-1", origin: "manual", status: "target-reached", reason: "none", removedCount: 1 }] }));
    const history = await service.history("mini-1", "1");
    expect(history.points).toHaveLength(1);
    expect(history.cleanupEvents).toHaveLength(2);
    expect(history.cleanupEvents.find(value => value.origin === "scheduled")).toMatchObject({ status: "refused", removedCount: 0, freeAfterSampledAt: null });
    expect((await service.list()).hosts[0].components[2].state).toBe("blocked");
    for (const bad of [{ ...event, path: "/private/source" }, { ...event, freeAfterSampledAt: new Date(start + 1).toISOString() },
      { ...event, finishedAt: new Date(start - 30_000).toISOString(), freeAfterSampledAt: new Date(start - 20_000).toISOString() }])
      expect(testHostSampleSchema.safeParse(sample(start, { cleanupEvents: [bad] })).success).toBe(false);
  });
  test("an overlapping pass round-trips as a skip and rejects contradictory completion claims", async () => {
    const service = new TestHostHealthService(new MemoryHealth(), () => new Date(start));
    const event: TestHostSample["cleanupEvents"][number] = { receiptId: "overlap", receiptSha256: "b".repeat(64), origin: "scheduled",
      startedAt: new Date(start - 1_000).toISOString(), finishedAt: new Date(start).toISOString(), status: "already-running",
      reason: "none", removedCount: 0, freeBefore: null, freeAfter: null, freeAfterSampledAt: null };
    await service.ingest(sample(start, { components: [{ component: "disk-cleanup", enabled: true, state: "scheduled", reason: "none" }],
      cleanupEvents: [event] }));
    expect((await service.list()).hosts[0].components[0].state).toBe("scheduled");
    expect((await service.history("mini-1", "1")).cleanupEvents).toEqual([event]);
    for (const change of [{ reason: "held-custody" }, { reason: "budget-limited" }, { removedCount: 1 }, { finishedAt: null }, { origin: "unknown" }] as const)
      expect(testHostSampleSchema.safeParse(sample(start, { cleanupEvents: [{ ...event, ...change }] })).success).toBe(false);
  });
});
describe("host health authorization", () => {
  const old = process.env.TEST_RUN_INGEST_TOKEN, token = randomUUID() + randomUUID();
  afterEach(() => { if (old === undefined) delete process.env.TEST_RUN_INGEST_TOKEN; else process.env.TEST_RUN_INGEST_TOKEN = old; });
  test("ingest capability is required; body validation errors reveal no raw input", async () => {
    process.env.TEST_RUN_INGEST_TOKEN = token;
    const repo = new MemoryHealth(), app = new Hono<AppEnv>();
    app.route("/api/internal/test-host-observations", createTestHostObservationsApi(new TestHostHealthService(repo, () => new Date(start))));
    const send = (body: unknown, auth?: string) => app.request("/api/internal/test-host-observations", { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer " + auth } : {}) }, body: JSON.stringify(body) });
    expect((await send(sample())).status).toBe(401);
    expect(repo.rows.size).toBe(0);
    const bad = await send({ ...sample(), error: "private host path" }, token);
    expect(bad.status).toBe(400); expect(await bad.text()).not.toContain("private host path");
    const input = sample(start, { memory: { totalBytes: 8 * 1024 ** 3, usedBytes: null, compressedBytes: null,
      swapUsedBytes: null, pressureFreePercent: 61, pressure: "normal" } });
    expect((await send(input, token)).status).toBe(201); expect((await send(input, token)).status).toBe(200);
    expect((await new TestHostHealthService(repo, () => new Date(start)).list()).hosts[0].memory).toEqual(input.memory);
    expect((await send({ padding: "x".repeat(33 * 1024) }, token)).status).toBe(413);
  });
  test("both Admin reads remain behind the real admin session gate; ingestion auth does not grant browsing", async () => {
    const repo = new MemoryHealth(), service = new TestHostHealthService(repo, () => new Date(start));
    const input = sample(start, { memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 5 * 1024 ** 3, compressedBytes: 1024 ** 3,
      swapUsedBytes: 0, pressureFreePercent: 61, pressure: "normal" } });
    await service.ingest(input);
    const app = new Hono<AppEnv>(); app.use("*", principalAuth);
    app.route("/", createTestRunAdminApi(service));
    for (const path of ["/health", "/health/mini-1?days=7"]) expect((await app.request(path, { headers: { authorization: "Bearer " + token } })).status).toBe(401);
    const read = createTestRunAdminApi(service);
    expect((await read.request("/health")).headers.get("cache-control")).toBe("no-store");
    const list = await (await read.request("/health")).json() as any;
    const history = await (await read.request("/health/mini-1?days=1")).json() as any;
    expect(list.hosts[0].memory).toEqual(input.memory); expect(history.points[0].memory).toEqual(input.memory);
    expect(history.points[0].freeBytes).toBe(input.freeBytes);
  });
});
