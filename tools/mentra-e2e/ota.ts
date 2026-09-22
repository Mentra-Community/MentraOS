#!/usr/bin/env bun
import {readFile} from "node:fs/promises"
import {join, resolve} from "node:path"
import {parseArgs} from "node:util"
import {buildDriver, command, snapshot, type Doctor} from "./runner/driver"
import {normalizeFirmware, otaPage} from "./runner/ota-state"
import {otaCommand as run} from "./runner/ota-hardware"
import {acquireLock, Report} from "./runner/report"
import {loadLegacyRoute, verifyPublishedLegacyManifests} from "./runner/ota-legacy-route"
import {runLifecycle, type AssertionObservation, type Json, type Reconciliation} from "./runner/lifecycle"
import {runOtaCustomerSequence, type OtaCustomerProgress} from "./runner/ota-customer-sequence"
import {createOtaRecording, otaRecordingSelection, type OtaRecordingFixture} from "./runner/ota-recording"

const {values} = parseArgs({
  args: process.argv.slice(2),
  options: {
    "fixture": {type: "string"},
    "manifest": {type: "string"},
    "manifest-url": {type: "string"},
    "build-manifest": {type: "string"},
    "install": {type: "boolean", default: false},
    "resume": {type: "boolean", default: false},
    "legacy-route": {type: "string"},
    "fixture-state-directory": {type: "string"},
    "timeout-minutes": {type: "string", default: "30"},
  },
})
for (const key of ["fixture", "manifest", "manifest-url", "build-manifest"] as const)
  if (!values[key]) throw new Error(`Missing --${key}`)
const fixture = (await Bun.file(values.fixture!).json()) as OtaRecordingFixture
if (
  !fixture.serial ||
  fixture.serial === "0123456789ABCDEF" ||
  Boolean(fixture.usb) === Boolean(fixture.wifiEndpoint) ||
  !/^[a-f\d]{32}$/i.test(fixture.cid) ||
  !fixture.bluetooth ||
  !fixture.before
)
  throw new Error(
    "Fixture needs a real serial, exactly one USB path or verified Wi-Fi endpoint, eMMC CID, Bluetooth address and initial versions",
  )
const manifestBytes = await Bun.file(values.manifest!).bytes()
const {manifest, target, manifestSha256} = otaRecordingSelection(fixture, manifestBytes)
const build = await Bun.file(values["build-manifest"]!).json()
if (build.otaManifestUrl !== values["manifest-url"])
  throw new Error("Build OTA pin differs from the requested manifest")
let legacy: Awaited<ReturnType<typeof loadLegacyRoute>> | undefined
if (values["legacy-route"]) {
  if (!values["fixture-state-directory"] || values.resume)
    throw new Error("Legacy replay requires --fixture-state-directory and cannot use the unowned --resume path")
  legacy = await loadLegacyRoute(await Bun.file(values["legacy-route"]).json(), {
    buildSha: build.buildSha,
    executableSha256: build.executableSha256,
    manifestSha256,
    manifestUrl: values["manifest-url"]!,
    beforeFirmware: fixture.before.firmware,
    beforeAsg: fixture.before.asgVersion,
    targetFirmware: target.firmware,
    targetAsg: target.asgVersion,
    targetPatches: manifest.mtk_patches,
  })
}
const url = new URL(values["manifest-url"]!)
if (url.protocol !== "https:" || url.username || url.password || url.hash)
  throw new Error("Expected a public HTTPS manifest URL")
const published = await fetch(url, {signal: AbortSignal.timeout(20000)})
if (!published.ok || !Buffer.from(await published.arrayBuffer()).equals(Buffer.from(manifestBytes)))
  throw new Error("Published OTA manifest differs from the reviewed local bytes")
const minutes = Number(values["timeout-minutes"])
if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60) throw new Error("Timeout must be 1–60 minutes")
await buildDriver()
const release = await acquireLock()
const report = new Report("mentra-live-ota", [])
let recording: Awaited<ReturnType<typeof createOtaRecording>> | undefined
const progress: OtaCustomerProgress = {started: false, installPasses: 0, finished: false}

try {
  await report.start(await command<Doctor>({op: "doctor"}), JSON.stringify(fixture), values["build-manifest"])
  recording = await createOtaRecording(report, {
    fixture,
    build,
    manifestBytes,
    manifestUrl: values["manifest-url"]!,
    legacy,
    resume: values.resume,
  })
  const {hardwareFolder, actions} = recording
  const {hardware, verifyTarget} = actions
  await report.startVideo()
  const customerSequence = () =>
    runOtaCustomerSequence(
      {install: values.install, resume: values.resume, minutes, before: fixture.before, target},
      progress,
      report.metadata,
      actions,
    )
  if (!legacy) {
    await customerSequence()
    const status = await report.finish(
      "passed",
      "All pinned component versions and the ASG artifact hash verified; paired home restored.",
    )
    if (status !== "passed") process.exitCode = 1
  } else {
    // A prepared baseline must be explicitly handed over by its owner. Never
    // initialize a second fixture registry to bypass unresolved setup writes.
    const fixtureDirectory = resolve(values["fixture-state-directory"]!)
    const ownership = JSON.parse(await readFile(join(fixtureDirectory, "fixture.json"), "utf8"))
    if (ownership.fixtureID !== fixture.cid.toLowerCase() || ownership.status !== "ready")
      throw new Error("Existing fixture owner has not handed over a ready baseline")
    const evidence = [join(hardwareFolder, "timeline.jsonl"), join(report.directory, "run.json")]
    const observation = (expected: Json, actual: Json) => ({
      expected,
      actual,
      observedAt: new Date().toISOString(),
      source: "ota.ts customer observer",
      evidence,
    })
    let customerError: string | undefined
    const targetAssertion = async (): Promise<AssertionObservation> => {
      await verifyTarget()
      return {
        ...observation("exact target components and paired home", {target, page: otaPage(await snapshot()).kind}),
        passed: progress.finished && otaPage(await snapshot()).kind === "home",
      }
    }
    const reconcile = async (_: unknown, intent?: unknown): Promise<Reconciliation> => {
      if (!intent) {
        const current = await hardware()
        const page = otaPage(await snapshot()).kind
        const ready =
          current.bootId === fixture.before.bootId &&
          current.slot === fixture.before.slot &&
          current.asgVersion === fixture.before.asgVersion &&
          current.firmware === normalizeFirmware(fixture.before.firmware) &&
          ["home", "offered"].includes(page)
        return {
          ...observation("prepared baseline and idle initial app screen", {bootId: current.bootId, page, ready}),
          status: ready ? "settled" : "unknown",
        }
      }
      // Recovery must never execute the UI loop. Completion must have been
      // independently verified in this process; otherwise retain ownership.
      if (!progress.finished || customerError)
        return {
          ...observation("verified customer sequence", {finished: progress.finished, error: customerError ?? null}),
          status: "unknown",
        }
      const proof = await targetAssertion()
      return {...proof, status: proof.passed ? "satisfied" : "unknown"}
    }
    const result = await runLifecycle({
      runDirectory: join(report.directory, "lifecycle"),
      fixtureDirectory,
      selection: {
        runID: report.directory.split("/").at(-1)!,
        fixtureID: fixture.cid.toLowerCase(),
        returnProfileDigest: manifestSha256,
        inputs: {fixture, build, legacyRoute: legacy.route} as unknown as Json,
      },
      // The outer process already owns acquireLock, acquired before any fixture read.
      acquireLease: async () => async () => {},
      routine: {
        id: "mentra-live-customer-ota",
        definitionDigest: String(report.metadata.harnessHash),
        preflight: [
          {
            id: "customer-inputs",
            kind: "assertion",
            instruction: "Verify selected inputs and prepared baseline without claiming setup qualification.",
            observe: async () => {
              await verifyPublishedLegacyManifests(legacy!.route.manifests)
              const check = await reconcile(undefined)
              return {...check, passed: check.status === "settled"}
            },
          },
        ],
        setup: [],
        test: [
          {
            id: "customer-sequence",
            kind: "mutation",
            repeat: "never",
            instruction: "Perform the bounded normal OTA sequence once; preserve ownership on any failure.",
            reconcile,
            execute: async () => {
              try {
                await customerSequence()
              } catch (error) {
                customerError = String(error)
                const mark = await report.video?.mark().catch(() => undefined)
                await report.record(
                  {
                    id: "OTA-FAILURE",
                    instruction: "Preserve the failed customer OTA observation without retrying.",
                    expected: "The complete selected target is verified.",
                    status: "failed",
                    error: customerError,
                    durationMs: 0,
                    videoStart: mark,
                    videoEnd: mark,
                  },
                  await snapshot().catch(() => undefined),
                )
                throw error
              }
              return {finished: progress.finished, installPasses: progress.installPasses}
            },
          },
        ],
        finalAssertions: [
          {
            id: "customer-target",
            kind: "assertion",
            instruction: "Independently verify the selected target components and paired home.",
            observe: targetAssertion,
          },
        ],
        teardown: [],
        returnVerification: [
          {
            id: "fixture-readiness",
            kind: "assertion",
            instruction: "Keep the fixture unavailable until a qualified idle/return observation adapter verifies it.",
            observe: async () => ({
              ...observation(
                "independent updater-idle and complete return-state proof",
                "not implemented; no restore adapter was executed",
              ),
              passed: false,
            }),
          },
        ],
        evidence: [
          {
            id: "customer-recording",
            kind: "assertion",
            instruction: "Finalize actual customer evidence separately from unresolved fixture readiness.",
            observe: async () => {
              const status = await report.finish(
                customerError || !progress.finished ? "failed" : "incomplete",
                "Customer-only replay; setup was external, no restoration was performed, fixture readiness remains unverified.",
              )
              const integrity = await run(["bun", resolve(import.meta.dir, "verify-run.ts"), report.directory])
              return {
                ...observation("finalized continuous recording and recorded steps", {
                  status,
                  video: report.metadata.video ?? null,
                  integrity,
                } as Json),
                passed: true,
              }
            },
          },
        ],
      },
    })
    report.metadata.lifecycle = result
    await report.flush()
    if (result.outcome !== "passed") process.exitCode = 1
  }
} catch (error) {
  if (report.directory) {
    const state = await snapshot().catch(() => undefined)
    await report.record(
      {
        id: "OTA-FAILURE",
        instruction: "Verify the complete OTA outcome.",
        expected: "Every target and paired-home restoration is proven.",
        status: "failed",
        durationMs: 0,
        error: String(error),
      },
      state,
    )
    await report.finish(
      "failed",
      "Observer stopped; app, network and glasses left untouched. Recover the existing session before retrying.",
    )
  }
  console.error(String(error))
  process.exitCode = 1
} finally {
  await recording?.close()
  await release()
}
