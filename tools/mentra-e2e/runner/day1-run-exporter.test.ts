import {afterEach, describe, expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {mkdtemp, mkdir, readFile, realpath, rm, symlink, truncate, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {testRunSchema} from "../../../cloud-v2/packages/core/src/types/test-run.types"
import {REQUEST_REPOSITORY, REQUEST_WORKFLOW} from "./ci-request"
import {exportDay1Run, type Day1Assessment} from "./day1-run-exporter"
import {assertFirmwareState, parseFirmwareProfile, type FirmwareObservation} from "./firmware-profile"
import {MAX_ASSET_BYTES} from "./test-run-record"

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, {recursive: true, force: true}) })
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n")
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const probe = async () => ({duration: 2, width: 8, height: 8})
const head = "a".repeat(40), build = "b".repeat(40), base = "c".repeat(40)
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "day1-export-")))
  directories.push(root)
  const runDirectory = join(root, "source"), outputDirectory = join(root, "export"), assessmentPath = join(root, "assessment.json")
  await mkdir(runDirectory)
  async function frozen(name: string, value: unknown) {
    const path = join(root, name), bytes = json(value)
    await writeFile(path, bytes)
    return {path, sha256: hash(bytes)}
  }
  const manifestUrl = `https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/pr-builds/ota-pr-4136-${head}.json`
  const app = {
    pr: 4136, headSha: head, buildSha: build, runId: 123, runAttempt: 1,
    bundleId: "com.mentra.mentra", app: "Mentra.app", backend: "dev", otaManifestUrl: manifestUrl,
    macPackageVersion: 2, macInstaller: "Install Mentra.app", mobileFingerprint: "f".repeat(64),
    mobileSourceCommit: build, reusedCompilation: false, version: "3.3.0", build: "303000123",
    executableSha256: "d".repeat(64), javascriptSha256: "e".repeat(64),
    profileUUID: "12345678-1234-1234-1234-123456789abc", profileExpires: "2027-05-28T04:05:18", teamId: "T5XXXL6N36",
  }
  const receipt = await frozen("receipt.json", {
    schemaVersion: 1, pr: app.pr, headSha: head, buildSha: build, runId: app.runId, runAttempt: app.runAttempt,
    app, artifacts: {mac: {sha256: "1".repeat(64)}},
  })
  const manifest = await frozen("manifest.json", {
    apps: {"com.mentra.asg_client": {versionCode: 303000123, apkUrl: "https://example.com/asg.apk", sha256: "2".repeat(64)}},
    bes_firmware: {version: "26.9.21.3", url: "https://example.com/bes.bin", sha256: "3".repeat(64)},
    mtk_full_ota: {end_firmware: "20260921.0", url: "https://example.com/mtk.zip", size: 100, sha256: "4".repeat(64)},
  })
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAD0lEQVR4nGNkwAFYhpYEAAyAAB70sjDxAAAAAElFTkSuQmCC", "base64")
  await writeFile(join(runDirectory, "screenshot.png"), png)
  await writeFile(join(runDirectory, "routine.mp4"), Buffer.from("00000018667479706d703432", "hex"))
  await writeFile(join(runDirectory, "raw.log"), "Private source material must not be copied.")
  const run = {
    status: "failed", executionMode: "interactive-discovery", evidenceVersion: 2,
    started: "2026-09-22T00:00:00.000Z", ended: "2026-09-22T00:00:10.000Z",
    harnessHash: "5".repeat(64), driverHash: "6".repeat(64), verifiedCiBuild: app,
    app: {bundleId: app.bundleId, version: app.version, build: app.build},
    appExecutableHash: app.executableSha256, appJavascriptHash: app.javascriptSha256,
    video: {event: "finished", duration: 2},
    results: ["failed", "passed"].map((status, index) => ({
      id: `OTA-0${index + 1}`, instruction: index ? "Inspect the failure" : "Start the update",
      expected: index ? "Record the visible error" : "The update starts", status,
      videoStart: index, videoEnd: index + 0.5, screenshot: "screenshot.png",
      screenshotVideoTime: index + 0.5, screenshotObservedVideoTime: index + 0.5, screenshotObservationAgeSeconds: 0.02,
    })),
  }
  const assessment: Day1Assessment = {
    schemaVersion: 1, executionMode: "manual-supervised", sourceRunSha256: "", fixtureAlias: "03BE", baseSha: base,
    receipt: {...receipt, url: "https://example.com/receipt.json"}, manifest: {...manifest, url: manifestUrl},
    outcomes: {test: "failed", teardown: "blocked", fixture: "unavailable"}, notes: "A reviewed failed customer observation; no firmware install occurred.",
  }
  async function save() {
    const bytes = json(run)
    await writeFile(join(runDirectory, "run.json"), bytes)
    await writeFile(join(runDirectory, "chapters.json"), json(run.results.filter(s => !["not-run", "not-applicable"].includes(s.status)).map(s => ({
      id: s.id, start: s.videoStart, end: s.videoEnd, description: s.instruction, expected: s.expected, status: s.status,
    }))))
    assessment.sourceRunSha256 = hash(bytes)
    await writeFile(assessmentPath, json(assessment))
  }
  async function finalState() {
    const profile = parseFirmwareProfile(await readFile(manifest.path), {url: manifestUrl, sha256: manifest.sha256, size: (await readFile(manifest.path)).length})
    const physical = {wifiEndpoint: "192.168.1.123:5555", cid: "7".repeat(32), bluetooth: "CC:E7:DE:E0:03:BE", serials: ["ML396102B"]}
    const observed: FirmwareObservation = {
      at: "2026-09-22T00:00:08.000Z", evidence: "hardware/observation.json", ...physical, serial: physical.serials[0],
      bootId: "d8564fd1-d6ec-4ecb-9f48-b91d7ed41aeb", bootCompleted: true, firmware: profile.mtk.version,
      asgVersion: profile.asg.versionCode, activeApkSha256: profile.asg.artifact.sha256,
      bes: {version: profile.bes.version, at: "2026-09-22T00:00:08.000Z", bootId: "d8564fd1-d6ec-4ecb-9f48-b91d7ed41aeb", evidence: "hardware/fresh-bes.json"},
      updateIdle: true, appConnected: true,
    }
    const profileRef = await frozen("profile.json", profile), fixtureRef = await frozen("fixture.json", physical), observationRef = await frozen("observation.json", observed)
    const checkedAt = "2026-09-22T00:00:09.000Z"
    const verification = {
      schemaVersion: 1, mode: "offline-assertion", checkedAt,
      inputs: {profileSha256: profileRef.sha256, fixtureSha256: fixtureRef.sha256, observationSha256: observationRef.sha256},
      status: "passed", assertions: assertFirmwareState(profile, physical, observed, Date.parse(checkedAt)),
      privateExtraField: "Never copy unknown verifier fields",
    }
    assessment.finalState = {profile: profileRef, fixture: fixtureRef, observation: observationRef, verification: await frozen("verification.json", verification)}
    return {verification, profile, physical, observed}
  }
  await save()
  return {root, run, assessment, frozen, finalState, save, options: {runDirectory, assessmentPath, outputDirectory}}
}

describe("finalized supervised day-one export", () => {
  test("preserves failed product step despite a passing failure inspection and exports only declared assets", async () => {
    const f = await fixture(), exported = await exportDay1Run(f.options, probe)
    expect(testRunSchema.safeParse(exported.result).success).toBe(true)
    expect(exported.outcome).toBe("failed")
    expect(exported.result.chapters.map(c => c.status)).toEqual(["failed", "passed"])
    expect(exported.result.outcomes).toEqual({test: "failed", teardown: "blocked", fixture: "unavailable", evidence: "complete"})
    expect(exported.result.provenance.mobileSourceCommit).toBe(build)
    expect(exported.result.provenance.reusedCompilation).toBe("false")
    expect(exported.result.assets.map(a => a.filename)).not.toContain("raw.log")
    for (const asset of exported.result.assets) expect(hash(await readFile(join(f.options.outputDirectory, asset.filename)))).toBe(asset.sha256)
    await expect(exportDay1Run(f.options, probe)).rejects.toThrow()
  })
  test("rejects active runs, unfinalized media, old evidence, and an assessment for different source bytes", async () => {
    for (const change of [
      (f: Awaited<ReturnType<typeof fixture>>) => { f.run.status = "running" },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.run.video.event = "started" },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.run.evidenceVersion = 1 },
    ]) {
      const f = await fixture(); change(f); await f.save()
      await expect(exportDay1Run(f.options, probe)).rejects.toThrow()
    }
    const f = await fixture(); await writeFile(f.options.assessmentPath, json({...f.assessment, sourceRunSha256: "0".repeat(64)}))
    await expect(exportDay1Run(f.options, probe)).rejects.toThrow("exact finalized")
  })
  test("never promotes a failed source or accepts a passing test without independent firmware verification", async () => {
    const f = await fixture(); f.assessment.outcomes.test = "passed"; await f.save()
    await expect(exportDay1Run(f.options, probe)).rejects.toThrow("cannot be promoted")
    f.run.status = "observed"; f.run.results.forEach(s => s.status = "passed"); await f.save()
    await expect(exportDay1Run(f.options, probe)).rejects.toThrow("bound final firmware")
  })
  test("recomputes complete final firmware proof while keeping unverified restoration blocked", async () => {
    const f = await fixture(); f.run.status = "observed"; f.run.results.forEach(s => s.status = "passed")
    f.assessment.outcomes.test = "passed"; await f.finalState(); await f.save()
    const exported = await exportDay1Run(f.options, probe)
    expect(exported.outcome).toBe("blocked")
    expect(exported.result.firmwareAssertions).toHaveLength(14)
    expect(exported.result.firmwareAssertions.every(a => a.status === "passed")).toBe(true)
    expect((await readFile(join(f.options.outputDirectory, "observations.json"), "utf8"))).not.toContain("privateExtraField")
  })
  test("accepts overall pass only with all recorded steps, firmware proof and explicit restoration claims", async () => {
    const f = await fixture(); f.run.status = "observed"; f.run.results.forEach(s => s.status = "passed")
    f.assessment.outcomes = {test: "passed", teardown: "passed", fixture: "ready"}; await f.finalState(); await f.save()
    expect((await exportDay1Run(f.options, probe)).outcome).toBe("passed")
  })
  test("a failed teardown does not rewrite an independently passed product test", async () => {
    const f = await fixture()
    f.run.results[0].status = "passed"; f.run.results[1].status = "failed"
    f.assessment.phaseByStep = {"OTA-01": "test", "OTA-02": "teardown"}
    f.assessment.outcomes = {test: "passed", teardown: "failed", fixture: "unavailable"}
    await f.finalState(); await f.save()
    const exported = await exportDay1Run(f.options, probe)
    expect(exported.outcome).toBe("failed")
    expect(exported.result.outcomes.test).toBe("passed")
    expect(exported.result.outcomes.teardown).toBe("failed")
  })
  test("rejects forged verdicts, unbound inputs and verification outside the run", async () => {
    for (const kind of ["assertions", "inputs", "time"]) {
      const f = await fixture(), {verification} = await f.finalState()
      if (kind === "assertions") verification.assertions[0].actual = "forged"
      if (kind === "inputs") verification.inputs.observationSha256 = "0".repeat(64)
      if (kind === "time") verification.checkedAt = "2026-09-21T00:00:09.000Z"
      f.assessment.finalState!.verification = await f.frozen("verification.json", verification); await f.save()
      await expect(exportDay1Run(f.options, probe)).rejects.toThrow()
    }
  })
  test("partial component proof records matching firmware without qualifying the full test or fixture", async () => {
    const f = await fixture()
    const proof = {
      verifiedAt: "2026-09-22T00:00:09.000Z", manifestSha256: f.assessment.manifest.sha256,
      state: {serial: "ML396102B", cid: "7".repeat(32), bluetooth: "CC:E7:DE:E0:03:BE",
        bootId: "d8564fd1-d6ec-4ecb-9f48-b91d7ed41aeb", bootCompleted: "1", firmware: "MentraLive_20260921.0", asgVersion: 303000123},
      apkSha256: "2".repeat(64), bes: {version: "26.9.21.3", ageSeconds: 9}, componentVersionsMatch: true,
      fullFixtureReturnQualified: false, privateExtraField: "Never copy unknown observations",
    }
    f.assessment.componentVerification = await f.frozen("components.json", proof); await f.save()
    const exported = await exportDay1Run(f.options, probe)
    expect(exported.outcome).toBe("failed")
    expect(exported.result.firmwareAssertions).toHaveLength(4)
    expect(exported.result.firmwareAssertions.every(row => row.status === "passed")).toBe(true)
    expect(await readFile(join(f.options.outputDirectory, "observations.json"), "utf8")).not.toContain("privateExtraField")
    f.run.status = "observed"; f.run.results.forEach(s => s.status = "passed")
    f.assessment.outcomes.test = "passed"; await f.save()
    await expect(exportDay1Run({...f.options, outputDirectory: join(f.root, "other-export")}, probe)).rejects.toThrow("bound final firmware")
    f.assessment.outcomes.test = "failed"; proof.apkSha256 = "0".repeat(64)
    f.assessment.componentVerification = await f.frozen("components.json", proof); await f.save()
    await expect(exportDay1Run({...f.options, outputDirectory: join(f.root, "mismatched-export")}, probe)).rejects.toThrow("contradicts")
  })
  test("rejects negative/out-of-video chapters and stale screen observations", async () => {
    for (const fields of [{videoStart: -0.5}, {videoEnd: 3}, {screenshotObservationAgeSeconds: 2}, {screenshotObservedVideoTime: -1}, {screenshotVideoTime: -1}]) {
      const f = await fixture(); Object.assign(f.run.results[0], fields); await f.save()
      await expect(exportDay1Run(f.options, probe)).rejects.toThrow()
      expect(await Bun.file(join(f.options.outputDirectory, "run.json")).exists()).toBe(false)
    }
  })
  test("rejects traversal, symlink assets and oversize recording without publishable metadata", async () => {
    for (const kind of ["traversal", "symlink", "oversize"]) {
      const f = await fixture()
      if (kind === "traversal") f.run.results[0].screenshot = "../manifest.json"
      if (kind === "symlink") {
        await symlink(join(f.options.runDirectory, "screenshot.png"), join(f.options.runDirectory, "link.png"))
        f.run.results[0].screenshot = "link.png"
      }
      if (kind === "oversize") await truncate(join(f.options.runDirectory, "routine.mp4"), MAX_ASSET_BYTES + 1)
      await f.save(); await expect(exportDay1Run(f.options, probe)).rejects.toThrow()
      expect(await Bun.file(join(f.options.outputDirectory, "run.json")).exists()).toBe(false)
    }
  })
  test("rejects a header-only PNG even when its dimensions match", async () => {
    const f = await fixture()
    await truncate(join(f.options.runDirectory, "screenshot.png"), 24)
    await expect(exportDay1Run(f.options, probe)).rejects.toThrow("decoded completely")
    expect(await Bun.file(join(f.options.outputDirectory, "run.json")).exists()).toBe(false)
  })
  test("probes the copied video and detects a subsequent change to that output", async () => {
    const f = await fixture()
    await expect(exportDay1Run(f.options, async path => {
      expect(path).toBe(join(f.options.outputDirectory, "routine.mp4"))
      await writeFile(path, "replacement")
      return probe()
    })).rejects.toThrow("Frozen output asset changed")
  })
  test("detects finalized source changes during media inspection", async () => {
    const f = await fixture()
    await expect(exportDay1Run(f.options, async () => {
      await writeFile(join(f.options.runDirectory, "run.json"), json({...f.run, status: "incomplete"}))
      return probe()
    })).rejects.toThrow("changed while exporting")
    expect(await Bun.file(join(f.options.outputDirectory, "run.json")).exists()).toBe(false)
  })
  test("preserves not-applicable as an explicit not-run mapping", async () => {
    const f = await fixture(); f.run.results[1].status = "not-applicable"; await f.save()
    const exported = await exportDay1Run(f.options, probe)
    expect(exported.result.chapters[1].status).toBe("not-run")
    expect(await readFile(join(f.options.outputDirectory, "observations.json"), "utf8")).toContain('"status": "not-applicable"')
  })
  test("related CI request remains context only, and another head is rejected", async () => {
    const f = await fixture(), source = "8".repeat(40)
    const request = {
      schemaVersion: 1, kind: "mentra-routine-request", requestId: "routine-200-1-4136-day1-ota", createdAt: "2026-09-21T10:10:00Z",
      status: "no-artifact", reason: "Mac build has not published",
      trigger: {kind: "pull_request", repository: REQUEST_REPOSITORY, workflow: REQUEST_WORKFLOW, runId: 200, runAttempt: 1,
        ref: "refs/pull/4136/merge", sha: source, workflowSha: source, workflowRef: `${REQUEST_REPOSITORY}/${REQUEST_WORKFLOW}@refs/pull/4136/merge`, actor: "tester"},
      pullRequest: {number: 4136, url: `https://github.com/${REQUEST_REPOSITORY}/pull/4136`, headSha: head, baseSha: base, headRepository: REQUEST_REPOSITORY, baseRef: "dev"},
      routine: {id: "day1-ota", reason: "Explicit routine:day1-ota PR label", harnessRevision: source}, selection: null, attempts: [],
    }
    f.assessment.relatedRequest = await f.frozen("request.json", request); await f.save()
    const exported = await exportDay1Run(f.options, probe)
    expect(exported.result.requestId).not.toBe(request.requestId)
    expect(exported.result.provenance.relatedRequestRelationship).toBe("context-only-not-consumed")
    request.pullRequest.headSha = "9".repeat(40)
    f.assessment.relatedRequest = await f.frozen("request.json", request); await f.save()
    await expect(exportDay1Run({...f.options, outputDirectory: join(f.root, "other-export")}, probe)).rejects.toThrow("another candidate")
  })
})
