import {expect, spyOn, test} from "bun:test"
import mongoose from "mongoose"
import {createHash, randomUUID} from "node:crypto"
import {mkdtemp, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {ReportModel} from "../models/report.model"
import {ReportAssetModel} from "../models/report-asset.model"
import {TestAssetModel} from "../models/test-run.model"
import {testFrameworkBinding, testRoutineSource} from "../testing/framework-fixtures"
import {recordedFrameworkRunSchema} from "../types/framework-run.types"
import {
  addLogArtifact,
  ensureTestRunReport,
  getReport,
  readReportArtifact,
  referenceTestRunDiagnostics,
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
      const receipts = await Promise.all([service.complete(frozen, hash), service.complete(frozen, hash)])
      expect(receipts[0]?.reportId).toBe(receipts[1]?.reportId)
      const final = await service.complete(frozen, hash)
      expect(final?.slack).toMatchObject({state: "sent", channel: "C1", ts: "1.2"})
      expect(sends).toBe(1)
      expect(await ReportModel.countDocuments()).toBe(1)
      expect(await ReportAssetModel.countDocuments()).toBe(2)
      const detail = await getReport(final!.reportId)
      expect(detail?.report.artifacts).toHaveLength(2)
      expect(detail?.report.slackDelivery?.state).toBe("sent")
      expect(detail?.report.context.build).toMatchObject({
        archive: {sha256: "d".repeat(64), size: 100},
        receipt: {sha256: "e".repeat(64), size: 25},
      })
      const raw = await ReportAssetModel.findOne({sourceTestRunId: "failed-run"}).lean()
      expect(raw?.sourceTestAssetId).toBe("setup-diagnostics")
      expect(raw?.storageKey).toBe(storageKey)
      const artifact = (await readReportArtifact(final!.reportId, raw!.artifactId))!
      expect(Buffer.from(await new Response(await artifact.stream()).arrayBuffer())).toEqual(bytes)
      // Repeat/restart only references the same raw object; no test asset is removed or copied.
      expect(await TestAssetModel.countDocuments()).toBe(1)
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
        expect(await ReportAssetModel.countDocuments()).toBe(2)
      } finally {collect.mockRestore()}
      const original = (await ReportModel.findOne({reportId: worker.reportId}).lean())!.logCollection
      await ensureTestRunReport("worker-run", "f".repeat(64))
      expect((await ReportModel.findOne({reportId: worker.reportId}).lean())!.logCollection).toEqual(original)
      // Retries do not backfill retained reports that predate source receipts.
      await ReportModel.updateOne({reportId: worker.reportId}, {$unset: {logCollection: ""}})
      await ensureTestRunReport("worker-run", "f".repeat(64))
      expect((await ReportModel.findOne({reportId: worker.reportId}).lean())!.logCollection).toBeUndefined()
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
