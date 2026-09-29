import { createHash, randomUUID } from "node:crypto";
import { TestRunModel } from "../models/test-run.model";
import { EVIDENCE_SUPPLEMENT_LIMIT, evidenceSupplementRequestSchema, evidenceSupplementReferenceSchema, evidenceSupplementManifestSchema,
  type EvidenceSupplement, type EvidenceSupplementManifest, type EvidenceSupplementReference } from "../types/test-failure-evidence.types";
import { createStorageService, type StorageService } from "./storage/storage.service";
import { testFailureEnvironment } from "./test-failure-auth";
import { canonical, MongoTestRunRepository, TestRunError, type TestRunRepository } from "./test-run.service";

const durable = { w: "majority" as const, j: true, wtimeout: 10000 };
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
type Settlement = Exclude<EvidenceSupplement["delivery"], { state: "pending" }>;
export interface EvidenceSupplementRepository {
  list(runId: string): Promise<EvidenceSupplement[]>;
  append(value: EvidenceSupplement): Promise<void>;
  pending(limit: number): Promise<EvidenceSupplement[]>;
  attempted(id: string): Promise<void>;
  settle(id: string, value: Settlement): Promise<void>;
}
/** Same accepted run document/outbox as corrections. The payload and occurrences are never updated. */
export class MongoEvidenceSupplementRepository implements EvidenceSupplementRepository {
  async list(runId: string) {
    const row = await TestRunModel.findOne({ runId }).select({ evidenceSupplements: 1 }).read("primary").readConcern("majority").lean();
    return (row?.evidenceSupplements ?? []) as EvidenceSupplement[];
  }
  async append(value: EvidenceSupplement) {
    const r = value.reference;
    await TestRunModel.updateOne({ runId: r.testRunId, payloadSha256: r.payloadSha256,
      failureOccurrences: { $elemMatch: { occurrenceId: r.occurrenceId, revision: r.revision,
        "delivery.state": "acknowledged", "delivery.agentRunId": r.agentRunId } },
      evidenceSupplements: { $not: { $elemMatch: { "reference.occurrenceId": r.occurrenceId,
        "reference.target.caseRevision": r.target.caseRevision, "reference.target.sessionSha256": r.target.sessionSha256 } } },
      $expr: { $lt: [{ $size: { $filter: { input: { $ifNull: ["$evidenceSupplements", []] }, as: "item",
        cond: { $eq: ["$$item.reference.occurrenceId", r.occurrenceId] } } } }, EVIDENCE_SUPPLEMENT_LIMIT] },
    }, { $push: { evidenceSupplements: value } }, { writeConcern: durable });
  }
  async pending(limit: number) {
    const rows = await TestRunModel.aggregate([
      { $match: { "evidenceSupplements.delivery.state": "pending" } }, { $unwind: "$evidenceSupplements" },
      { $match: { "evidenceSupplements.delivery.state": "pending" } },
      { $sort: { "evidenceSupplements.delivery.lastAttemptAt": 1, startedAt: 1, "evidenceSupplements.reference.supplementId": 1 } },
      { $limit: limit }, { $project: { _id: 0, value: "$evidenceSupplements" } },
    ]).read("primary").readConcern("majority");
    return rows.map(row => row.value as EvidenceSupplement);
  }
  async attempted(id: string) {
    await TestRunModel.updateOne({ evidenceSupplements: { $elemMatch: { "reference.supplementId": id, "delivery.state": "pending" } } },
      { $set: { "evidenceSupplements.$.delivery.lastAttemptAt": new Date().toISOString() } }, { writeConcern: durable });
  }
  async settle(id: string, delivery: Settlement) {
    await TestRunModel.updateOne({ evidenceSupplements: { $elemMatch: { "reference.supplementId": id, "delivery.state": "pending",
      ...(delivery.state === "acknowledged" ? { "reference.agentRunId": delivery.agentRunId } : {}) } } },
    { $set: { "evidenceSupplements.$.delivery": delivery } }, { writeConcern: durable });
  }
}
type Runs = Pick<TestRunRepository, "get" | "failure" | "assets" | "insertAsset">;
const storedAssetId = (id: string, assetId: string) => `${id}-${assetId}`;
const sameStop = (a: EvidenceSupplementReference, b: EvidenceSupplementReference) => a.occurrenceId === b.occurrenceId
  && a.target.caseRevision === b.target.caseRevision && a.target.sessionSha256 === b.target.sessionSha256;
function referenceFor(manifest: EvidenceSupplementManifest) {
  const { reason: _reason, redactionPolicy: _policy, assets: _assets, ...identity } = manifest;
  const supplementSha256 = sha256(canonical(manifest));
  return evidenceSupplementReferenceSchema.parse({ ...identity, supplementId: `tes_${supplementSha256}`, supplementSha256 });
}

export class TestFailureEvidenceService {
  constructor(private readonly runs: Runs = new MongoTestRunRepository(),
    readonly repository: EvidenceSupplementRepository = new MongoEvidenceSupplementRepository(),
    private readonly storageFactory: () => StorageService = createStorageService,
    private readonly environment = testFailureEnvironment, private readonly now = () => new Date()) {}

  private async bind(r: EvidenceSupplementReference) {
    const stored = await this.runs.get(r.testRunId), occurrence = stored?.failureOccurrences?.find(item => item.occurrenceId === r.occurrenceId);
    if (!stored || stored.payloadSha256 !== r.payloadSha256 || occurrence?.revision !== r.revision
      || occurrence.delivery.state !== "acknowledged" || occurrence.delivery.agentRunId !== r.agentRunId)
      throw new TestRunError(409, "supplement differs from the accepted payload, occurrence or acknowledged anchor");
    if (r.environment !== this.environment()) throw new TestRunError(409, "supplement names another environment");
    return stored;
  }

  /** Exact reviewed JSON bytes are stored first; only complete content receives an append-only manifest and delivery. */
  async submit(runId: string, occurrenceId: string, input: unknown, reviewedBy: string) {
    if (!reviewedBy || reviewedBy.length > 240) throw new TestRunError(400, "authenticated admin identity required");
    const parsed = evidenceSupplementRequestSchema.safeParse(input);
    if (!parsed.success) throw new TestRunError(400, "invalid reviewed evidence supplement");
    const { manifest, content } = parsed.data;
    if (manifest.testRunId !== runId || manifest.occurrenceId !== occurrenceId) throw new TestRunError(400, "supplement differs from its route");
    const reference = referenceFor(manifest);
    const original = await this.bind(reference);
    if (content.length !== manifest.assets.length || new Set(content.map(item => item.assetId)).size !== content.length)
      throw new TestRunError(400, "content differs from the reviewed manifest");
    const bytes = manifest.assets.map(asset => {
      const text = content.find(item => item.assetId === asset.assetId)?.json;
      if (text === undefined) throw new TestRunError(400, "content differs from the reviewed manifest");
      const body = Buffer.from(text, "utf8");
      if (body.length !== asset.sizeBytes || sha256(body) !== asset.sha256 || body.toString("utf8") !== text)
        throw new TestRunError(400, "diagnostic size, UTF-8 or digest differs from the reviewed manifest");
      try { JSON.parse(text); } catch { throw new TestRunError(400, "diagnostic is not JSON"); }
      if (original.run.assets.some(item => item.assetId === storedAssetId(reference.supplementId, asset.assetId)))
        throw new TestRunError(409, "supplement asset collides with an original asset");
      return body;
    });
    const existing = await this.repository.list(runId);
    const replay = existing.find(item => item.reference.supplementId === reference.supplementId);
    if (replay) return { supplement: replay, created: false };
    if (existing.some(item => sameStop(item.reference, reference))
      || existing.filter(item => item.reference.occurrenceId === occurrenceId).length >= EVIDENCE_SUPPLEMENT_LIMIT)
      throw new TestRunError(409, "this stop already has a supplement or its evidence bound is reached");
    const storage = this.storageFactory(), uploaded = await this.runs.assets(runId);
    for (const [index, asset] of manifest.assets.entries()) {
      const assetId = storedAssetId(reference.supplementId, asset.assetId), previous = uploaded.find(item => item.assetId === assetId);
      if (previous) {
        if (previous.sha256 !== asset.sha256 || previous.sizeBytes !== asset.sizeBytes) throw new TestRunError(409, "stored diagnostic differs");
        continue;
      }
      const storageKey = `test-runs/${runId}/supplements/${reference.supplementId}/${asset.assetId}/${randomUUID()}`;
      const object = await storage.putObject({ key: storageKey, body: bytes[index]!, contentType: "application/json" });
      if (object.sizeBytes !== asset.sizeBytes || object.sha256 !== asset.sha256)
        throw new TestRunError(409, "stored diagnostic differs");
      const winner = await this.runs.insertAsset({ runId, assetId, storageKey, sizeBytes: asset.sizeBytes, sha256: asset.sha256 });
      if (winner.storageKey !== storageKey) await storage.deleteObject(storageKey).catch(() => undefined);
      if (winner.sha256 !== asset.sha256 || winner.sizeBytes !== asset.sizeBytes) throw new TestRunError(409, "stored diagnostic differs");
    }
    const supplement: EvidenceSupplement = { reference, manifest, reviewedBy, reviewedAt: this.now().toISOString(), delivery: { state: "pending" } };
    await this.repository.append(supplement);
    const saved = (await this.repository.list(runId)).find(item => item.reference.supplementId === reference.supplementId);
    if (!saved) throw new TestRunError(409, "supplement target changed; read the existing occurrence again");
    return { supplement: saved, created: saved.reviewedAt === supplement.reviewedAt && saved.reviewedBy === reviewedBy };
  }

  private async required(occurrenceId: string, id: string) {
    if (!/^tfo_[a-f0-9]{64}$/.test(occurrenceId) || !/^tes_[a-f0-9]{64}$/.test(id)) throw new TestRunError(400, "invalid evidence identity");
    const stored = await this.runs.failure(occurrenceId);
    const supplement = stored && (await this.repository.list(stored.run.runId)).find(item => item.reference.supplementId === id
      && item.reference.occurrenceId === occurrenceId && item.delivery.state !== "refused");
    if (!supplement) throw new TestRunError(404, "supplement is not assigned to this occurrence");
    let manifest: EvidenceSupplementManifest;
    try { manifest = evidenceSupplementManifestSchema.parse(supplement.manifest); }
    catch { throw new TestRunError(409, "stored supplement manifest is invalid"); }
    if (canonical(referenceFor(manifest)) !== canonical(supplement.reference))
      throw new TestRunError(409, "stored supplement manifest differs");
    await this.bind(supplement.reference);
    return supplement;
  }

  async list(runId: string, occurrenceId: string) {
    const stored = await this.runs.failure(occurrenceId);
    if (!stored || stored.run.runId !== runId) throw new TestRunError(404, "failure occurrence not found in this run");
    return { testRunId: runId, occurrenceId, payloadSha256: stored.payloadSha256,
      supplements: (await this.repository.list(runId)).filter(item => item.reference.occurrenceId === occurrenceId) };
  }

  async metadata(occurrenceId: string, id: string) {
    const value = await this.required(occurrenceId, id), uploaded = await this.runs.assets(value.reference.testRunId);
    const assets = value.manifest.assets.map(asset => {
      if (!uploaded.some(item => item.assetId === storedAssetId(id, asset.assetId) && item.sizeBytes === asset.sizeBytes && item.sha256 === asset.sha256))
        throw new TestRunError(409, "supplement diagnostic is unavailable");
      return { ...asset, kind: "metadata" as const, contentType: "application/json" as const, filename: `${asset.assetId}.json`, state: "uploaded" as const,
        path: `/api/agent/test-failures/${occurrenceId}/evidence-supplements/${id}/assets/${asset.assetId}` };
    });
    return { reference: value.reference, manifest: value.manifest, reviewedAt: value.reviewedAt, assets };
  }
  async media(occurrenceId: string, id: string, assetId: string, request: Request) {
    const value = await this.metadata(occurrenceId, id), meta = value.assets.find(item => item.assetId === assetId);
    if (!meta) throw new TestRunError(404, "diagnostic is not assigned to this supplement");
    const object = (await this.runs.assets(value.reference.testRunId)).find(item => item.assetId === storedAssetId(id, assetId))!;
    const bytes = await this.storageFactory().getObject(object.storageKey);
    if (bytes.length !== meta.sizeBytes || sha256(bytes) !== meta.sha256) throw new TestRunError(409, "stored diagnostic bytes differ");
    return new Response(request.method === "HEAD" ? null : bytes, { headers: { "Content-Type": "application/json", "Content-Length": String(meta.sizeBytes),
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
      ETag: `"${meta.sha256}"` } });
  }
}
