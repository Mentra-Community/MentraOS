import { createHash } from "node:crypto";
import { TestHostLatestModel, TestHostSampleModel } from "../models/test-host-health.model";
import { DISK_FLOOR_BYTES, DISK_GAP_MS, HOST_FRESH_MS, HOST_HISTORY_DAYS, HOST_SAMPLE_LIMIT, testHostSampleSchema,
  type CleanupHealthEvent, type TestHostHistory, type TestHostLatest, type TestHostList, type TestHostSample } from "../types/test-host-health.types";
import {frameworkIdentitySchema as testResourceHostIdSchema} from "../types/framework-request.types";

const DAY_MS = 86_400_000;
const HOST_LIMIT = 32;
export class TestHostHealthError extends Error {
  constructor(public status: 400 | 404 | 409, message: string) { super(message); }
}
export interface StoredHostSample {
  hostId: string; sampleId: string; sampledAt: Date; receivedAt: Date; expiresAt: Date; digest: string; payload: TestHostSample;
}
export interface TestHostHealthRepository {
  insert(sample: StoredHostSample): Promise<boolean>;
  get(hostId: string, sampleId: string): Promise<StoredHostSample | null>;
  updateLatest(sample: StoredHostSample): Promise<void>;
  hosts(limit: number): Promise<Array<Pick<StoredHostSample, "payload" | "receivedAt">>>;
  history(hostId: string, from: Date, to: Date, limit: number): Promise<TestHostSample[]>;
}
const duplicate = (error: unknown) => (error as { code?: number })?.code === 11000;
export class MongoTestHostHealthRepository implements TestHostHealthRepository {
  async insert(sample: StoredHostSample) {
    try { await TestHostSampleModel.collection.insertOne(sample, { writeConcern: { w: "majority", j: true } }); return true; }
    catch (error) { if (duplicate(error)) return false; throw error; }
  }
  async get(hostId: string, sampleId: string) {
    return await TestHostSampleModel.collection.findOne({ hostId, sampleId }, { readPreference: "primary" }) as StoredHostSample | null;
  }
  async updateLatest(sample: StoredHostSample) {
    const { hostId, sampleId, sampledAt, receivedAt, payload } = sample;
    const filter = { hostId, $or: [
      { sampledAt: { $lt: sampledAt } }, { sampledAt, sampleId: { $lte: sampleId } },
    ] }, update = { $set: { hostId, sampleId, sampledAt, receivedAt, payload } };
    // Only actual sample time orders observations. Backlogged delivery and exact retries never refresh contact.
    try {
      await TestHostLatestModel.collection.updateOne(filter, update, { upsert: true, writeConcern: { w: "majority", j: true } });
    } catch (error) {
      if (!duplicate(error)) throw error;
      // A first writer may have inserted an older row after our upsert selected no document.
      // Re-evaluate the same monotonic predicate against the now-existing row; never insert or regress it.
      await TestHostLatestModel.collection.updateOne(filter, update, { writeConcern: { w: "majority", j: true } });
    }
  }
  async hosts(limit: number) {
    return await TestHostLatestModel.collection.find<Pick<StoredHostSample, "payload" | "receivedAt">>({}, { projection: { _id: 0, payload: 1, receivedAt: 1 } })
      .sort({ hostId: 1 }).limit(limit).maxTimeMS(5_000).toArray();
  }
  async history(hostId: string, from: Date, to: Date, limit: number) {
    const rows = await TestHostSampleModel.collection.find({ hostId, sampledAt: { $gte: from, $lte: to } },
      { projection: { _id: 0, payload: 1 } }).sort({ sampledAt: -1, sampleId: -1 }).hint("host_sample_history")
      .limit(limit).maxTimeMS(5_000).toArray();
    return rows.map(row => row.payload as TestHostSample);
  }
}
const canonical = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]"
  : "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";

export class TestHostHealthService {
  constructor(private repository: TestHostHealthRepository = new MongoTestHostHealthRepository(), private now = () => new Date()) {}

  async ingest(input: unknown) {
    const parsed = testHostSampleSchema.safeParse(input);
    if (!parsed.success) throw new TestHostHealthError(400, "invalid host observation");
    const payload = parsed.data, receivedAt = this.now(), sampledAt = new Date(payload.sampledAt);
    if (sampledAt.getTime() > receivedAt.getTime() + 5_000 || sampledAt.getTime() < receivedAt.getTime() - HOST_HISTORY_DAYS * DAY_MS)
      throw new TestHostHealthError(400, "sample time must be within retained history and not in the future");
    const digest = createHash("sha256").update(canonical(payload)).digest("hex");
    const row: StoredHostSample = { hostId: payload.hostId, sampleId: payload.sampleId, sampledAt, receivedAt, digest, payload,
      expiresAt: new Date(sampledAt.getTime() + HOST_HISTORY_DAYS * DAY_MS) };
    const inserted = await this.repository.insert(row);
    const accepted = inserted ? row : await this.repository.get(row.hostId, row.sampleId);
    if (!accepted || accepted.digest !== digest) throw new TestHostHealthError(409, "sample identity already has different content");
    // Also completes a previously interrupted latest-row write, without changing its original receipt time.
    await this.repository.updateLatest(accepted);
    return { accepted: true, created: inserted, sampleId: accepted.sampleId, receivedAt: accepted.receivedAt.toISOString() };
  }

  async list(): Promise<TestHostList> {
    const rows = await this.repository.hosts(HOST_LIMIT + 1);
    const hosts: TestHostLatest[] = rows.slice(0, HOST_LIMIT).flatMap(row => {
      const parsed = testHostSampleSchema.safeParse(row.payload);
      return parsed.success ? [{ ...parsed.data, receivedAt: row.receivedAt.toISOString() }] : [];
    });
    return { generatedAt: this.now().toISOString(), hosts, truncated: rows.length > HOST_LIMIT, freshForMs: HOST_FRESH_MS };
  }

  async history(hostId: string, days: string | undefined): Promise<TestHostHistory> {
    if (!testResourceHostIdSchema.safeParse(hostId).success || days !== undefined && days !== "1" && days !== "7")
      throw new TestHostHealthError(400, "invalid host or history window");
    const to = this.now(), from = new Date(to.getTime() - Number(days ?? "1") * DAY_MS);
    const rows = await this.repository.history(hostId, from, to, HOST_SAMPLE_LIMIT + 1);
    const retained = rows.slice(0, HOST_SAMPLE_LIMIT).reverse();
    const events = new Map<string, CleanupHealthEvent>();
    for (const row of retained) for (const event of row.cleanupEvents) {
      if (Date.parse(event.startedAt) >= from.getTime() && Date.parse(event.startedAt) <= to.getTime())
        events.set(event.receiptId, event); // Latest observed receipt version; immutable sample history is unchanged.
    }
    return { hostId, generatedAt: to.toISOString(), from: from.toISOString(), to: to.toISOString(),
      points: retained.map(({ sampleId, sampledAt, freeBytes, memory }) => ({ sampleId, sampledAt, freeBytes,
        ...(memory === undefined ? {} : { memory }) })),
      cleanupEvents: [...events.values()].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)),
      truncated: rows.length > HOST_SAMPLE_LIMIT, thresholdBytes: DISK_FLOOR_BYTES, gapAfterMs: DISK_GAP_MS };
  }
}
