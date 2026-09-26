import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { TestResourceObservationModel } from "../models/test-resource-observation.model";
import {
  testResourceHostIdSchema, testResourceKeySchema, testResourceObservationPutSchema,
  type TestResourceObservation, type TestResourceObservationPut, type TestResourceObservationPutResponse,
  type TestResourceObservationRecord, type TestResourceProgressCheckpoint,
} from "../types/test-resource-observation.types";

export class TestResourceObservationError extends Error {
  constructor(readonly status: 400 | 409, message: string) { super(message); }
}
export interface StoredTestResourceObservation {
  hostId: string;
  resourceKey: string;
  revision: number;
  receivedAt: string;
  observation: TestResourceObservation;
  progress?: TestResourceProgressCheckpoint;
  requestSha256: string;
}
export interface TestResourceObservationRepository {
  get(hostId: string, resourceKey: string): Promise<StoredTestResourceObservation | null>;
  /** Writes revision 1 only when no row exists; false when another write already created it. */
  insert(value: StoredTestResourceObservation): Promise<boolean>;
  /** Replaces the row only while it is still at `expectedRevision`; false otherwise. */
  replace(expectedRevision: number, value: StoredTestResourceObservation): Promise<boolean>;
}

const writeConcern = { w: "majority" as const, j: true, wtimeout: 10_000 };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
type Row = { hostId: string; resourceKey: string; revision: number; receivedAt: Date; observation: unknown; progress?: unknown; requestSha256: string };
export function storedObservation(row: Row): StoredTestResourceObservation {
  return { hostId: row.hostId, resourceKey: row.resourceKey, revision: row.revision, receivedAt: row.receivedAt.toISOString(),
    observation: row.observation as TestResourceObservation, requestSha256: row.requestSha256,
    ...(row.progress ? { progress: row.progress as TestResourceProgressCheckpoint } : {}) };
}

export class MongoTestResourceObservationRepository implements TestResourceObservationRepository {
  async get(hostId: string, resourceKey: string) {
    const row = await TestResourceObservationModel.findOne({ hostId, resourceKey }).read("primary").readConcern("majority").lean();
    return row ? storedObservation(row as Row) : null;
  }
  private document(value: StoredTestResourceObservation) {
    return { revision: value.revision, receivedAt: new Date(value.receivedAt), observation: value.observation, requestSha256: value.requestSha256 };
  }
  async insert(value: StoredTestResourceObservation) {
    try {
      await TestResourceObservationModel.create([{ hostId: value.hostId, resourceKey: value.resourceKey, ...this.document(value),
        ...(value.progress ? { progress: value.progress } : {}) }], { writeConcern });
      return true;
    } catch (error) {
      if ((error as { code?: number })?.code === 11000) return false;
      throw error;
    }
  }
  async replace(expectedRevision: number, value: StoredTestResourceObservation) {
    const result = await TestResourceObservationModel.updateOne(
      { hostId: value.hostId, resourceKey: value.resourceKey, revision: expectedRevision },
      value.progress ? { $set: { ...this.document(value), progress: value.progress } }
        : { $set: this.document(value), $unset: { progress: 1 } },
      { writeConcern },
    );
    return result.matchedCount === 1;
  }
}

function path(hostId: string, resourceKey: string) {
  if (!testResourceHostIdSchema.safeParse(hostId).success || !testResourceKeySchema.safeParse(resourceKey).success)
    throw new TestResourceObservationError(400, "invalid host ID or resource key");
}
function present(value: StoredTestResourceObservation): TestResourceObservationRecord {
  return { schemaVersion: 1, hostId: value.hostId, resourceKey: value.resourceKey, revision: value.revision,
    receivedAt: value.receivedAt, observation: value.observation, progress: value.progress ?? null };
}
const conflict = () => new TestResourceObservationError(409,
  "resource observation revision changed; discard this snapshot, read the current revision and observe again");

/**
 * Latest-only reporting for one host resource. Compare-and-set on the server
 * revision orders writers; device clocks never do. Within one owner's run the
 * committed journal sequence orders progress, and another owner never inherits it.
 * Nothing here reads or changes claims, results, fixtures or admission.
 */
export class TestResourceObservationService {
  constructor(private readonly repository: TestResourceObservationRepository = new MongoTestResourceObservationRepository(),
    private readonly now = () => new Date()) {}

  async get(hostId: string, resourceKey: string): Promise<TestResourceObservationRecord> {
    path(hostId, resourceKey);
    const stored = await this.repository.get(hostId, resourceKey);
    return stored ? present(stored) : { schemaVersion: 1, hostId, resourceKey, revision: 0, receivedAt: null, observation: null, progress: null };
  }

  async put(hostId: string, resourceKey: string, input: unknown): Promise<TestResourceObservationPutResponse> {
    path(hostId, resourceKey);
    const parsed = testResourceObservationPutSchema.safeParse(input);
    if (!parsed.success) throw new TestResourceObservationError(400, "invalid resource observation");
    const request = parsed.data;
    if (request.hostId !== hostId || request.resourceKey !== resourceKey)
      throw new TestResourceObservationError(400, "body identity does not match the path");
    const requestSha256 = createHash("sha256").update(canonical(request)).digest("hex");
    const current = await this.repository.get(hostId, resourceKey);
    if ((current?.revision ?? 0) !== request.expectedRevision) return this.replay(current, request, requestSha256);
    const receivedAt = this.now().toISOString();
    const next: StoredTestResourceObservation = { hostId, resourceKey, revision: request.expectedRevision + 1, receivedAt,
      observation: request.observation, requestSha256 };
    const progress = this.progress(current, request, receivedAt);
    if (progress) next.progress = progress;
    const written = request.expectedRevision === 0 ? await this.repository.insert(next)
      : await this.repository.replace(request.expectedRevision, next);
    if (!written) return this.replay(await this.repository.get(hostId, resourceKey), request, requestSha256);
    return { ...present(next), applied: true };
  }

  /** Only the exact request that produced the current revision is acknowledged again, unchanged. */
  private replay(current: StoredTestResourceObservation | null, request: TestResourceObservationPut, requestSha256: string) {
    if (current && current.revision === request.expectedRevision + 1 && current.requestSha256 === requestSha256)
      return { ...present(current), applied: false };
    throw conflict();
  }

  private progress(current: StoredTestResourceObservation | null, request: TestResourceObservationPut, receivedAt: string) {
    const owner = request.observation.owner?.valid ? request.observation.owner : undefined;
    const runId = owner?.reservation?.runID;
    // Only the same observed run keeps its checkpoint; a new or absent owner starts empty.
    const previous = runId && current?.progress?.runId === runId ? current.progress : undefined;
    if (!request.progress) return previous;
    if (!previous || request.progress.sequence > previous.sequence) return { ...request.progress, receivedAt };
    const { receivedAt: _, ...saved } = previous;
    if (request.progress.sequence === previous.sequence && !isDeepStrictEqual(saved, request.progress))
      throw new TestResourceObservationError(409, "journal sequence already has a different checkpoint");
    return previous;
  }
}
