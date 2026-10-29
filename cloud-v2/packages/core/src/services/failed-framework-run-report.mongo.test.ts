import {expect, spyOn, test} from "bun:test"
import mongoose from "mongoose"
import {z} from 'zod'
import {createHash, randomUUID} from "node:crypto"
import {mkdtemp, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {ReportModel} from "../models/report.model"
import {ReportAssetModel, reconcileReportAssetIndexes} from "../models/report-asset.model"
import {writeRunEnvelope, completeStoredRun} from "./framework-run-detail.service"
import {FrameworkResultService} from './framework-result.service'
import {TestingDetailStorage} from './testing-detail-storage.service'
import {TestAssetService} from "./test-asset.service"
import {TestAssetModel, TestRunModel} from "../models/test-run.model"
import {testFrameworkBinding, testRoutineSource} from "../testing/framework-fixtures"
import {recordedFrameworkRunSchema} from "../types/framework-run.types"
import {
  addLogArtifact,
  ensureTestRunReport,
  getReport,
  readReportArtifact,
  referenceTestRunDiagnostics,
  referenceDeviceIncidentDiagnostics,
} from "./report.service"
import {FailedFrameworkRunReportService} from "./failed-framework-run-report.service"
import {ReportSlackDeliveryService} from "./report-slack-delivery.service"
import {requestInputDigest} from "./test-request.service"
import {StorageService} from "./storage/storage.service"
import {LocalStorageProvider} from "./storage/providers/local-storage.provider"
import {REPORT_LOG_SOURCES} from "./report-log-collection"
import * as serverLogs from "./report-cloud-logs"
import {ReportServerLogCollectionService} from "./report-server-log-collection.service"

const uri = process.env.FAILED_RUN_REPORT_MONGO_URI
;(uri ? test : test.skip)(
  "real Mongo concurrent completion dedupes reports, raw reference bytes, summary and Slack independently of native custody",
  async () => {
    if (!uri?.startsWith("mongodb://127.0.0.1:")) throw Error("Integration requires explicit loopback Mongo")
    const directory = await mkdtemp(join(tmpdir(), "mentra-report-integration-"))
    const savedDirectory = process.env.CLOUD_STORAGE_LOCAL_DIR,
      savedProvider = process.env.CLOUD_STORAGE_PROVIDER
    process.env.CLOUD_STORAGE_LOCAL_DIR = directory
    process.env.CLOUD_STORAGE_PROVIDER = "local"
    const storage = new StorageService(new LocalStorageProvider({rootDir: directory}))
    await mongoose.connect(uri, {dbName: `incident_${randomUUID().replaceAll("-", "")}`})
    try {
      await Promise.all([ReportModel.createIndexes(), ReportAssetModel.createIndexes(), TestAssetModel.createIndexes()])
      const bytes = Buffer.from(
        JSON.stringify({
          failures: [
            {
              phase: "setup",
              actionId: "launch",
              message: "Original ownership timeout",
              diagnostics: {callbacks: [{operation: "assertOwned", phase: "timed-out"}]},
            },
          ],
        }),
      )
      const digest = createHash("sha256").update(bytes).digest("hex"),
        storageKey = "test-runs/fixture/original"
      await storage.putObject({key: storageKey, body: bytes, contentType: "application/json"})
      await TestAssetModel.create({
        runId: "failed-run",
        assetId: "setup-diagnostics",
        storageKey,
        sha256: digest,
        sizeBytes: bytes.length,
      })
      const frozen = recordedFrameworkRunSchema.parse({
        schemaVersion: 1,
        requestId: "failed-run",
        hostId: "host",
        laneId: "android",
        routineId: "notes",
        routineSource: testRoutineSource(),
        frameworkBinding: testFrameworkBinding(),
        definitionRevision: "a".repeat(40),
        platform: "android",
        build: {
          repository: "Mentra-Community/MentraOS",
          channel: "dev",
          headSha: "b".repeat(40),
          archive: {sha256: "d".repeat(64), size: 100, url: "https://example.test/private-artifact"},
          receipt: {sha256: "e".repeat(64), size: 25},
        },
        startedAt: "2026-10-07T10:00:00Z",
        finishedAt: "2026-10-07T10:01:00Z",
        assets: [
          {
            id: "setup-diagnostics",
            kind: "diagnostic",
            path: "setup-diagnostics.json",
            sha256: digest,
            size: bytes.length,
            mimeType: "application/json",
          },
        ],
        result: {
          runId: "failed-run",
          finishedAt: "2026-10-07T10:01:00Z",
          setup: {status: "failed"},
          test: "not-run",
          steps: [{id: "required", status: "not-run", durationMs: 0, causedBy: "launch"}],
          teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
          failures: [{phase: "setup", actionId: "launch", message: "Original ownership timeout"}],
          evidence: ["setup-diagnostics"],
          timing: {startedAt: "2026-10-07T10:00:00Z", setupMs: 10, testMs: 0, teardownMs: 10},
        },
      })
      let sends = 0
      const delivery = new ReportSlackDeliveryService(undefined, async () => {
        sends++
        return {ok: true, receipt: {channel: "C1", ts: "1.2"}}
      })
      const service = new FailedFrameworkRunReportService({
        ensure: ensureTestRunReport,
        attach: (input, retry) => addLogArtifact(input, {...retry!, storage}),
        references: referenceTestRunDiagnostics,
        delivery,
      })
      const hash = requestInputDigest(frozen)
      const detailPointer = await writeRunEnvelope(frozen, hash, [{runId: frozen.result.runId, assetId: 'setup-diagnostics', storageKey, sha256: digest, sizeBytes: bytes.length}], true)
      await TestRunModel.collection.insertOne({runId: frozen.result.runId, payloadSha256: hash, uploadsComplete: true, resultSchemaVersion: 1, detail: detailPointer})
      await TestAssetModel.deleteMany({})
      // A duplicate that began before completion must reuse the compacted winner,
      // even if its pending receipt insert happens after completion's cleanup.
      const stale = spyOn(TestRunModel, 'findOne').mockImplementationOnce(() => ({
        select() {return this}, read() {return this}, readConcern() {return this}, async lean() {return null},
      }) as never)
      try {
        const uploaded = await new TestAssetService(undefined, () => storage).uploadDeclaredAsset('failed-run',
          {assetId: 'setup-diagnostics', kind: 'metadata', contentType: 'application/json', filename: 'setup-diagnostics.json',
            sizeBytes: bytes.length, sha256: digest}, new Blob([bytes]).stream(),
          new Headers({'content-type': 'application/json', 'content-length': String(bytes.length)}), async () => {})
        expect(uploaded.created).toBe(false)
        expect(await TestAssetModel.countDocuments()).toBe(0)
        expect(await storage.getObject(storageKey)).toEqual(bytes)
      } finally {stale.mockRestore()}
      const pending = structuredClone(frozen)
      pending.requestId = pending.result.runId = 'pending-completion'
      const pendingHash = requestInputDigest(pending)
      const emptyDetail = await writeRunEnvelope(pending, pendingHash, [], false)
      await TestRunModel.collection.insertOne({runId: pending.result.runId, payloadSha256: pendingHash,
        resultSchemaVersion: 1, detail: emptyDetail, uploadsComplete: false})
      await TestAssetModel.create({runId: pending.result.runId, assetId: 'setup-diagnostics', storageKey,
        sha256: digest, sizeBytes: bytes.length})
      const realUpdate = TestRunModel.updateOne.bind(TestRunModel)
      const updateLost = spyOn(TestRunModel, 'updateOne').mockImplementationOnce(((...args: any[]) =>
        (realUpdate as any)(...args).then(() => {throw Error('committed update acknowledgement lost')})) as never)
      const deleteLost = spyOn(TestAssetModel, 'deleteMany').mockRejectedValueOnce(Error('receipt cleanup unavailable'))
      try {
        await expect(completeStoredRun(pending, pendingHash)).rejects.toThrow('receipt cleanup unavailable')
        expect((await TestRunModel.findOne({runId: pending.result.runId}).lean())!.uploadsComplete).toBe(true)
        expect(await TestAssetModel.countDocuments({runId: pending.result.runId})).toBe(1)
        await Promise.all([completeStoredRun(pending, pendingHash), completeStoredRun(pending, pendingHash)])
        expect(await TestAssetModel.countDocuments({runId: pending.result.runId})).toBe(0)
      } finally {updateLost.mockRestore(); deleteLost.mockRestore()}
      const mediaPending = structuredClone(pending)
      mediaPending.requestId = mediaPending.result.runId = 'media-completion-race'
      const mediaHash = requestInputDigest(mediaPending)
      const mediaDetail = await writeRunEnvelope(mediaPending, mediaHash, [], false)
      await TestRunModel.collection.insertOne({runId: mediaPending.result.runId, payloadSha256: mediaHash,
        resultSchemaVersion: 1, detail: mediaDetail, uploadsComplete: false})
      await TestAssetModel.create({runId: mediaPending.result.runId, assetId: 'setup-diagnostics', storageKey,
        sha256: digest, sizeBytes: bytes.length})
      const actualDetailRead = TestingDetailStorage.prototype.read
      const completionDuringRead = spyOn(TestingDetailStorage.prototype, 'read').mockImplementationOnce(async function <T>(this: TestingDetailStorage, pointer: unknown, schema: z.ZodType<T>): Promise<T> {
        const envelope = await actualDetailRead.call(this, pointer, schema) as T
        await completeStoredRun(mediaPending, mediaHash)
        return envelope
      })
      try {
        const response = await new FrameworkResultService().mediaByRun(mediaPending.result.runId, 'setup-diagnostics',
          new Request('http://localhost/media'))
        expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
        expect(await TestAssetModel.countDocuments({runId: mediaPending.result.runId})).toBe(0)
      } finally {completionDuringRead.mockRestore()}
      const receipts = await Promise.all([service.complete(frozen, hash), service.complete(frozen, hash)])
      expect(receipts[0]?.reportId).toBe(receipts[1]?.reportId)
      const final = await service.complete(frozen, hash)
      expect(final?.slack).toMatchObject({state: "sent", channel: "C1", ts: "1.2"})
      expect(sends).toBe(1)
      expect(await ReportModel.countDocuments()).toBe(1)
      expect(await ReportAssetModel.countDocuments()).toBe(1)
      const detail = await getReport(final!.reportId)
      expect(detail?.report.artifacts).toHaveLength(2)
      expect(detail?.report.slackDelivery?.state).toBe("sent")
      expect(detail?.report.context.build).toMatchObject({
        archive: {sha256: "d".repeat(64), size: 100},
        receipt: {sha256: "e".repeat(64), size: 25},
      })
      const raw = detail!.assets.find(asset => asset.storageKey === storageKey)!
      expect(raw.storageKey).toBe(storageKey)
      const artifact = (await readReportArtifact(final!.reportId, raw.artifactId))!
      expect(Buffer.from(await new Response(await artifact.stream()).arrayBuffer())).toEqual(bytes)
      // Native bytes have one accepted authority; completed run receipt rows are unnecessary.
      expect(await TestAssetModel.countDocuments()).toBe(0)
      expect(await storage.getObject(storageKey)).toEqual(bytes)

      // Both failed-run and worker-diagnostic fallbacks expose collection gaps.
      // Native diagnostic references and the framework summary are not device logs.
      const worker = await ensureTestRunReport("worker-run", "f".repeat(64))
      for (const reportId of [final!.reportId, worker.reportId]) {
        const row = (await ReportModel.findOne({reportId}).lean())!
        const collection = row.logCollection!
        expect(Object.keys(collection).sort()).toEqual([...REPORT_LOG_SOURCES].sort())
        for (const source of REPORT_LOG_SOURCES) {
          expect(collection[source]).toMatchObject({state: "unavailable", reason:
            source === "cloud" || source === "miniapp_server"
              ? "No trusted Mentra user identity is available for server log correlation"
              : "No device-filed report is available to request device log collection"})
          expect(Date.parse(collection[source]!.requestedAt)).toBeFinite()
          expect(Date.parse(collection[source]!.deadlineAt)).toBeGreaterThan(Date.parse(collection[source]!.requestedAt))
          expect(collection[source]!.artifactId).toBeUndefined()
          expect(collection[source]!.receivedAt).toBeUndefined()
          expect(collection[source]!.entryCount).toBeUndefined()
        }
        expect((await getReport(reportId))!.report.logCollection).toEqual(collection)
        // Bypass Mongoose's immutable timestamp only in this isolated fixture so
        // the real reconciliation query can otherwise claim the report.
        await ReportModel.collection.updateOne({reportId}, {$set: {createdAt: new Date(Date.now() - 60_000)}})
      }
      const collect = spyOn(serverLogs, "collectServerLogs").mockRejectedValue(new Error("Unexpected automation owner lookup"))
      try {
        await new ReportServerLogCollectionService().tick()
        expect(collect).not.toHaveBeenCalled()
        expect(await ReportAssetModel.countDocuments()).toBe(1)
      } finally {collect.mockRestore()}
      const original = (await ReportModel.findOne({reportId: worker.reportId}).lean())!.logCollection
      await ensureTestRunReport("worker-run", "f".repeat(64))
      expect((await ReportModel.findOne({reportId: worker.reportId}).lean())!.logCollection).toEqual(original)
      // Retries do not backfill retained reports that predate source receipts.
      await ReportModel.updateOne({reportId: worker.reportId}, {$unset: {logCollection: ""}})
      await ensureTestRunReport("worker-run", "f".repeat(64))
      expect((await ReportModel.findOne({reportId: worker.reportId}).lean())!.logCollection).toBeUndefined()

      // Model the already-deployed unique payload index. Cut it over before a
      // device and fallback report can share the same acknowledged test blob.
      await ReportAssetModel.collection.createIndex({storageKey: 1}, {unique: true})
      await reconcileReportAssetIndexes()
      await ReportAssetModel.createIndexes()
      const deviceOwner = {reportId: "rep_DEVICEshared", mentraUserId: "authenticated-device-owner"}
      const correlation = {alertId: "original-alert", testRunId: frozen.result.runId}
      await ReportModel.create({...deviceOwner, kind: "automatic", status: "ready", artifacts: [], context: {},
        automationCorrelation: correlation,
        trigger: {source: "mentra_automated_testing", reason: "incident_report_requested"}})
      await Promise.all([referenceDeviceIncidentDiagnostics(deviceOwner.reportId, correlation, frozen),
        referenceDeviceIncidentDiagnostics(deviceOwner.reportId, correlation, frozen)])
      await referenceDeviceIncidentDiagnostics(deviceOwner.reportId, correlation, frozen)
      expect(await ReportAssetModel.countDocuments({storageKey})).toBe(0)
      const deviceDetail = (await getReport(deviceOwner.reportId))!
      expect(deviceDetail.report.artifacts).toHaveLength(1)
      const deviceRaw = deviceDetail.assets.find(asset => asset.storageKey === storageKey)!
      expect(deviceRaw.artifactId).not.toBe(raw.artifactId)
      expect(deviceRaw.sha256).toBe(digest)
      const deviceArtifact = (await readReportArtifact(deviceOwner.reportId, deviceRaw.artifactId))!
      expect(Buffer.from(await new Response(await deviceArtifact.stream()).arrayBuffer())).toEqual(bytes)
      expect(await storage.getObject(storageKey)).toEqual(bytes)
    } finally {
      await mongoose.connection.dropDatabase()
      await mongoose.disconnect()
      await rm(directory, {recursive: true, force: true})
      if (savedDirectory === undefined) delete process.env.CLOUD_STORAGE_LOCAL_DIR
      else process.env.CLOUD_STORAGE_LOCAL_DIR = savedDirectory
      if (savedProvider === undefined) delete process.env.CLOUD_STORAGE_PROVIDER
      else process.env.CLOUD_STORAGE_PROVIDER = savedProvider
    }
  },
  20_000,
)
