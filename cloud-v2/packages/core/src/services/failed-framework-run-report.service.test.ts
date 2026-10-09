import {afterEach, expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {testFrameworkBinding, testRoutineSource} from "../testing/framework-fixtures"
import {recordedFrameworkRunSchema, type RecordedFrameworkRun} from "../types/framework-run.types"
import {
  FailedFrameworkRunReportService,
  failedRunDiagnostics,
  FAILED_RUN_DIAGNOSTIC_BYTES,
} from "./failed-framework-run-report.service"
import {FrameworkResultService} from "./framework-result.service"
import {requestInputDigest} from "./test-request.service"

const savedEnv = process.env.CLOUD_CORE_ENVIRONMENT
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLOUD_CORE_ENVIRONMENT
  else process.env.CLOUD_CORE_ENVIRONMENT = savedEnv
})
function run(
  platform: "android" | "ios-on-mac",
  phase: "setup" | "test" | "teardown" | "evidence" | "pass" | "cancelled",
): RecordedFrameworkRun {
  const failure = {phase, actionId: "required", message: `Original ${phase} cause`}
  const value = {
    schemaVersion: 1,
    requestId: `failure-${platform}-${phase}`,
    hostId: "host",
    laneId: platform,
    routineId: "notes",
    routineSource: testRoutineSource(),
    frameworkBinding: testFrameworkBinding(),
    definitionRevision: "a".repeat(40),
    platform,
    build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)},
    startedAt: "2026-10-07T10:00:00Z",
    finishedAt: "2026-10-07T10:01:00Z",
    assets: [],
    result: {
      runId: `failure-${platform}-${phase}`,
      finishedAt: "2026-10-07T10:01:00Z",
      setup: {status: phase === "setup" ? "failed" : phase === "cancelled" ? "cancelled" : "passed"},
      test:
        phase === "setup" ? "not-run" : phase === "cancelled" ? "cancelled" : phase === "test" ? "failed" : "passed",
      steps: [
        {
          id: "required",
          status: phase === "setup" || phase === "cancelled" ? "not-run" : phase === "test" ? "failed" : "passed",
          durationMs: 10,
          ...(phase === "setup" ? {causedBy: "required"} : {}),
        },
      ],
      teardown: {
        ready: phase !== "teardown",
        outcomes: [],
        errors: phase === "teardown" ? [failure] : [],
        unavailableResources: [],
      },
      failures: phase === "pass" || phase === "cancelled" ? [] : [failure],
      evidence: [],
      timing: {startedAt: "2026-10-07T10:00:00Z", setupMs: 10, testMs: 10, teardownMs: 10},
    },
  }
  return recordedFrameworkRunSchema.parse(value)
}
function service() {
  const reports = new Map<string, string>(),
    attachments = new Map<string, string>()
  let references = 0,
    notifications = 0
  return {
    reports,
    attachments,
    get references() {
      return references
    },
    get notifications() {
      return notifications
    },
    instance: new FailedFrameworkRunReportService({
      async ensure(id, digest, details) {
        const key = id + digest
        reports.set(key, JSON.stringify(details))
        return {reportId: key, mentraUserId: "automation:test-run"}
      },
      async references(_owner, frozen) {
        references += frozen.assets.length
        return frozen.assets.length
      },
      async attach(input, retry) {
        const bytes = JSON.stringify({entries: input.entries}),
          key = input.reportId + retry!.key
        if (attachments.has(key)) expect(attachments.get(key)).toBe(bytes)
        attachments.set(key, bytes)
        return {
          stored: 1,
          receipt: {
            artifactId: key,
            sizeBytes: Buffer.byteLength(bytes),
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        }
      },
      delivery: {
        async complete() {
          notifications++
          return {state: "pending", error: "Slack unavailable"}
        },
      },
    }),
  }
}
for (const platform of ["android", "ios-on-mac"] as const)
  for (const phase of ["setup", "test", "teardown", "evidence"] as const)
    test(`${platform} ${phase} report uses frozen cause and retries one attachment without changing verdict`, async () => {
      process.env.CLOUD_CORE_ENVIRONMENT = "dev"
      const frozen = run(platform, phase),
        before = JSON.stringify(frozen),
        hash = requestInputDigest(frozen),
        fixture = service()
      const first = await fixture.instance.complete(frozen, hash),
        second = await fixture.instance.complete(frozen, hash)
      expect(second).toEqual(first)
      expect(first?.slack.state).toBe("pending")
      expect(fixture.reports.size).toBe(1)
      expect(fixture.attachments.size).toBe(1)
      const diagnostic = JSON.parse([...fixture.attachments.values()][0]!).entries[0]
      expect(diagnostic.message).toContain(`Original ${phase} cause`)
      expect(diagnostic.message).toContain("https://admin.dev.mentraglass.com/?testRun=")
      expect(JSON.stringify(frozen)).toBe(before)
    })
for (const platform of ["android", "ios-on-mac"] as const)
  for (const phase of ["pass", "cancelled"] as const)
    test(`${platform} clean ${phase} creates no report`, async () => {
      const fixture = service(),
        frozen = run(platform, phase)
      expect(await fixture.instance.complete(frozen, requestInputDigest(frozen))).toBeUndefined()
      expect(fixture.reports.size).toBe(0)
      expect(fixture.notifications).toBe(0)
    })
test("bounded summary declares omissions and preserves exact provenance without arbitrary build metadata", () => {
  process.env.CLOUD_CORE_ENVIRONMENT = "dev"
  const frozen = run("android", "test")
  frozen.result.failures = Array.from({length: 21}, (_, i) => ({
    phase: "test",
    actionId: `step-${i}`,
    message: "cause ".repeat(2000),
  }))
  frozen.assets = Array.from({length: 55}, (_, i) => ({
    id: `diagnostic-${i}`,
    kind: "diagnostic",
    path: `private/${i}.json`,
    sha256: "c".repeat(64),
    size: 2,
    mimeType: "application/json",
  }))
  frozen.build.credential = "unfiltered-build-secret"
  const diagnostic = failedRunDiagnostics(frozen),
    bytes = JSON.stringify(diagnostic)
  expect(diagnostic.failures).toHaveLength(20)
  expect(diagnostic.omittedFailures).toBe(1)
  expect(diagnostic.assets).toHaveLength(50)
  expect(diagnostic.omittedAssets).toBe(5)
  expect(diagnostic.diagnosticAttachments).toBe(55)
  expect(diagnostic.failures[0]?.messageTruncated).toBe(true)
  expect(bytes).not.toContain("unfiltered-build-secret")
  expect(Buffer.byteLength(bytes)).toBeLessThan(FAILED_RUN_DIAGNOSTIC_BYTES)
})
test("screenshots lead capped links and all screenshots retain incident references on retry", async () => {
  process.env.CLOUD_CORE_ENVIRONMENT = "dev"
  const frozen = run("android", "test")
  frozen.assets = Array.from({length: 50}, (_, index) => ({id: `diagnostic-${index}`, kind: "diagnostic",
    path: `diagnostics/${index}.json`, sha256: "c".repeat(64), size: 2, mimeType: "application/json"}))
  frozen.assets.push({id: "failed-step-image", kind: "screenshot", path: "screenshots/original-failure.png", sha256: "e".repeat(64), size: 200, mimeType: "image/png"},
    {id: "generic-screenshot", kind: "screenshot", path: "screenshots/original.png", sha256: "d".repeat(64), size: 100, mimeType: "image/png"})
  const before = requestInputDigest(frozen), diagnostic = failedRunDiagnostics(frozen)
  expect(diagnostic.assets.slice(0, 2).map(asset => asset.id)).toEqual(["failed-step-image", "generic-screenshot"])
  expect(diagnostic.assets).toHaveLength(50); expect(diagnostic.omittedAssets).toBe(2)
  expect(diagnostic.diagnosticAttachments).toBe(52)
  expect(diagnostic.assets[0]).toMatchObject({kind: "screenshot", sha256: "e".repeat(64), size: 200,
    url: `https://admin.dev.mentraglass.com/api/admin/routine-catalog/results/by-run/${frozen.result.runId}/assets/failed-step-image`})
  const fixture = service()
  expect(await fixture.instance.complete(frozen, before)).toEqual(await fixture.instance.complete(frozen, before))
  expect(fixture.attachments.size).toBe(1)
  expect(fixture.references).toBe(104)
  expect(requestInputDigest(frozen)).toBe(before)
})
test("native completion acknowledges evidence before incident retry and pending Slack does not poison uploads", async () => {
  const frozen = run("android", "setup"),
    hash = requestInputDigest(frozen)
  const stored = {payload: frozen, payloadSha256: hash, uploadsComplete: false}
  let writes = 0,
    attempts = 0
  const svc = new FrameworkResultService(
    {
      async insert() {},
      async getByRequest() {
        return stored
      },
      async getByRun() {
        return stored
      },
      async getAsset() {
        return null
      },
    },
    async () => ({hostId: "host", input: {} as never}),
    undefined,
    undefined,
    undefined,
    {
      async list() {
        return []
      },
      async complete() {
        writes++
        stored.uploadsComplete = true
      },
    },
    {
      async complete() {
        expect(stored.uploadsComplete).toBe(true)
        if (++attempts === 1) throw Error("Report storage unavailable")
        return {reportId: "rep-one", artifactId: "art-one", slack: {state: "pending"}}
      },
    },
  )
  await expect(svc.complete(frozen.requestId, "host")).rejects.toThrow("Report storage unavailable")
  expect(stored.uploadsComplete).toBe(true)
  expect(await svc.complete(frozen.requestId, "host")).toMatchObject({incident: {slack: {state: "pending"}}})
  expect(writes).toBe(1)
  expect(requestInputDigest(stored.payload)).toBe(hash)
})
test("undetailed teardown failure is reported while clean not-run/cancellation stays silent", async () => {
  const frozen = run("android", "pass")
  frozen.result.teardown.ready = false
  const fixture = service()
  expect(await fixture.instance.complete(frozen, requestInputDigest(frozen))).toBeDefined()
  const cancelled = run("android", "cancelled")
  cancelled.result.teardown.ready = false
  expect(await fixture.instance.complete(cancelled, requestInputDigest(cancelled))).toBeUndefined()
})
test("large accepted causes compact by actual UTF-8 attachment bytes with first cause and omission counts", async () => {
  const frozen = run("android", "test")
  frozen.result.failures = Array.from({length: 30}, (_, index) => ({
    phase: "test",
    actionId: `original-${index}`,
    message: '\\"💥'.repeat(3000),
  }))
  frozen.assets = Array.from({length: 50}, (_, index) => ({
    id: `diagnostic-${index}-${"a".repeat(450)}`,
    kind: "diagnostic",
    path: `${index}.json`,
    size: 2,
    sha256: "a".repeat(64),
    mimeType: "application/json",
  }))
  const fixture = service()
  await fixture.instance.complete(frozen, requestInputDigest(frozen))
  const bytes = [...fixture.attachments.values()][0]!
  expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(FAILED_RUN_DIAGNOSTIC_BYTES)
  const diagnostic = JSON.parse(JSON.parse(bytes).entries[0].message)
  expect(diagnostic.failures[0].actionId).toBe("original-0")
  expect(diagnostic.omittedFailures + diagnostic.failures.length).toBe(30)
  expect(diagnostic.omittedAssets + diagnostic.assets.length).toBe(50)
  expect(diagnostic.diagnosticAttachments).toBe(50)
  expect(fixture.references).toBe(50)
})

test("original classified failures still report when aggregate test is cancelled or not-run", async () => {
  for (const status of ["cancelled", "not-run"] as const) {
    const frozen = run("android", "cancelled")
    frozen.result.setup.status = "passed"
    frozen.result.test = status
    frozen.result.failures = [{phase: "test", actionId: "entry", message: "Original failure before product steps"}]
    const accepted = recordedFrameworkRunSchema.parse(frozen),
      fixture = service()
    expect(await fixture.instance.complete(accepted, requestInputDigest(accepted))).toBeDefined()
  }
})
