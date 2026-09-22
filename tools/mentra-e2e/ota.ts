#!/usr/bin/env bun
import {createHash} from "node:crypto"
import {appendFile, chmod, copyFile, mkdir, readFile} from "node:fs/promises"
import {join, resolve} from "node:path"
import {parseArgs} from "node:util"
import {buildDriver, command, snapshot, type Doctor, type Snapshot} from "./runner/driver"
import {freshBesProof, otaFirmwareRoute, normalizeFirmware, otaPage} from "./runner/ota-state"
import {observeOtaHardware, otaCommand as run, readOtaHardware, type OtaFixture} from "./runner/ota-hardware"
import {acquireLock, Report} from "./runner/report"
import {executeSteps} from "./runner/suite"
import {legacyAppPairChecks, loadLegacyRoute, verifyPublishedLegacyManifests} from "./runner/ota-legacy-route"
import {runLifecycle, type AssertionObservation, type Json, type Reconciliation} from "./runner/lifecycle"

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
const fixture = (await Bun.file(values.fixture!).json()) as OtaFixture & {
  before: {firmware: string; asgVersion: number; bootId: string; slot: string}
}
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
const manifest = JSON.parse(new TextDecoder().decode(manifestBytes))
const app = manifest.apps?.["com.mentra.asg_client"]
const target = {
  asgVersion: app?.versionCode,
  asgSha256: app?.sha256,
  firmware: normalizeFirmware(manifest.mtk_full_ota?.end_firmware),
  bes: manifest.bes_firmware?.version,
}
if (
  !Number.isInteger(target.asgVersion) ||
  !/^[a-f\d]{64}$/i.test(target.asgSha256 ?? "") ||
  !target.firmware ||
  !target.bes
)
  throw new Error("Manifest must pin ASG, full MTK fallback and BES targets")
const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex")
let allowedFirmware = otaFirmwareRoute(fixture.before.firmware, target.firmware, manifest.mtk_patches)
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
  allowedFirmware = legacy.allowedFirmware
}
const allowedAsg = legacy?.allowedAsg ?? [fixture.before.asgVersion, target.asgVersion]
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
let logger: ReturnType<typeof Bun.spawn> | undefined
let loggingTransport = ""
let logSegment = 0
let hardwareFolder = ""
let started = false
let installPasses = 0
let finished = false
let index = 0
let lastHardware = ""

async function hardware(observingActivePass = false) {
  const {shell, ...state} = await readOtaHardware(
    fixture,
    allowedFirmware,
    allowedAsg,
    legacy ? false : observingActivePass,
  )
  const {transport, asgVersion, firmware, bootId} = state
  if (transport !== loggingTransport || !logger || logger.exitCode !== null) {
    if (logger && logger.exitCode === null) {
      logger.kill()
      await logger.exited
    }
    const log = join(hardwareFolder, `transport-${transport}-${++logSegment}-private.log`)
    await Bun.write(log, "")
    await chmod(log, 0o600)
    logger = Bun.spawn(["adb", "-t", transport, "logcat", "-v", "epoch", "-T", "1"], {
      stdout: Bun.file(log),
      stderr: Bun.file(log + ".stderr"),
    })
    loggingTransport = transport
  }
  const encoded = JSON.stringify(state)
  if (encoded !== lastHardware) {
    await appendFile(
      join(hardwareFolder, "timeline.jsonl"),
      JSON.stringify({at: new Date().toISOString(), ...state}) + "\n",
      {mode: 0o600},
    )
    lastHardware = encoded
    console.log(`Hardware: ASG ${asgVersion}, MTK ${firmware}, boot ${bootId}`)
  }
  return {...state, shell}
}
async function observe(instruction: string, state: Snapshot, expected = instruction) {
  const mark = await report.video!.mark()
  const result = await report.record(
    {
      id: `OTA-${String(++index).padStart(2, "0")}`,
      instruction,
      expected,
      status: "passed",
      durationMs: 0,
      videoStart: mark,
      videoEnd: mark,
      focusBefore: state.frontmostBundleId,
      focusAfter: state.frontmostBundleId,
    },
    state,
  )
  if (result.status !== "passed") throw new Error(result.error ?? "OTA observation evidence failed")
}
async function press(identifier: string, instruction: string) {
  const ok = await executeSteps(
    [
      {
        id: `OTA-${String(++index).padStart(2, "0")}`,
        instruction,
        expected: "The named control accepts the action; the following observation verifies the resulting state.",
        action: {op: "press", selector: {identifier, enabled: true}},
        checks: [{selector: {identifier}, absent: true}],
        timeoutMs: 15000,
      },
    ],
    {fixture: fixture.serial, email: "", password: ""},
    report,
  )
  if (!ok) throw new Error("OTA UI action failed; do not retry the installation automatically")
}
async function verifyAppPair() {
  const identity = legacy ? await hardware() : undefined
  const steps = [
    {
      instruction: "Open Settings to identify the app's paired glasses.",
      action: {op: "press", selector: {identifier: "home.miniapp.com.mentra.settings"}},
      checks: [{selector: {role: "AXGenericElement", contains: "Device info"}}],
    },
    {
      instruction: legacy
        ? "Match the app’s full Bluetooth MAC and ASG build to the independently identified glasses."
        : "Match the app's device serial and Bluetooth address to the selected fixture.",
      action: {op: "press", selector: {role: "AXGenericElement", contains: "Device info"}},
      checks: legacy
        ? legacyAppPairChecks(fixture.bluetooth, identity!.asgVersion)
        : [
            {selector: {role: "AXGenericElement", contains: fixture.serial}},
            {selector: {role: "AXGenericElement", contains: fixture.bluetooth}},
          ],
    },
    {
      instruction: "Close Device info and return to paired home.",
      action: {op: "press", selector: {identifier: "miniapp.close"}},
      checks: [{selector: {identifier: "miniapp.close"}, absent: true}],
    },
  ].map((step) => ({...step, id: `OTA-${String(++index).padStart(2, "0")}`, expected: step.instruction}))
  if (!(await executeSteps(steps, {fixture: fixture.serial, email: "", password: ""}, report)))
    throw new Error("The app's paired device does not match the selected fixture")
}
async function verifyTarget() {
  if (legacy) await verifyPublishedLegacyManifests(legacy.route.manifests)
  const identity = await hardware()
  if (
    identity.firmware !== target.firmware ||
    identity.asgVersion !== target.asgVersion ||
    identity.bootCompleted !== "1"
  )
    throw new Error("App completion does not match the installed ASG and MTK targets")
  // This fixture returned empty tag-filtered dumps while the same live buffer
  // contained version responses. Bound the raw read, then select proofs locally.
  const logs = await run(["adb", "-t", identity.transport, "logcat", "-d", "-v", "epoch", "-t", "12000"])
  const epoch = Number(await identity.shell("date", "+%s"))
  const proof = freshBesProof(logs, identity.bootId, epoch)
  if (proof.version !== target.bes) throw new Error(`Expected BES ${target.bes}, received ${proof.version}`)
  const apk = (await identity.shell("pm", "path", "com.mentra.asg_client")).split("\n")
  if (apk.length !== 1 || !apk[0].startsWith("package:/")) throw new Error("Installed ASG package path is ambiguous")
  const hash = (await identity.shell("sha256sum", apk[0].slice(8))).split(/\s+/)[0]
  if (hash !== target.asgSha256) throw new Error("Installed ASG APK hash differs from the OTA manifest")
  await Bun.write(join(hardwareFolder, "bes-version-private.log"), logs)
  await chmod(join(hardwareFolder, "bes-version-private.log"), 0o600)
  const {shell: _, ...device} = identity
  await Bun.write(
    join(hardwareFolder, "verified-target.json"),
    JSON.stringify({at: new Date().toISOString(), ...device, bes: proof, apkSha256: hash}, null, 2),
  )
  await observe(
    "Verify the actual ASG APK, MTK firmware and fresh BES response match every pinned target.",
    await snapshot(),
  )
}
try {
  await report.start(await command<Doctor>({op: "doctor"}), JSON.stringify(fixture), values["build-manifest"])
  hardwareFolder = join(report.directory, "hardware")
  await mkdir(hardwareFolder, {mode: 0o700})
  await copyFile(values.manifest!, join(hardwareFolder, "manifest.json"))
  report.metadata.ota = {
    url: url.href,
    manifestSha256,
    target,
    allowedFirmware,
    allowedAsg,
    legacyRoute: legacy?.route ?? null,
    scope: legacy
      ? "customer-upgrade-only; January setup and automatic restoration are not qualified"
      : "normal-update",
    resume: values.resume,
    nativeAssociationQualified: false,
  }
  await report.startVideo()
  async function customerSequence() {
    const before = await hardware(
      values.resume && ["working", "checking", "pass-complete"].includes(otaPage(await snapshot()).kind),
    )
    // ASG and MTK can stay unchanged in a BES-only release. Require a fresh BES
    // response before deciding to skip the app's normal installation flow.
    let alreadyCurrent = false
    if (!values.resume && before.asgVersion === target.asgVersion && before.firmware === target.firmware) {
      const logs = await run(["adb", "-t", before.transport, "logcat", "-d", "-v", "epoch", "-t", "12000"])
      const proof = freshBesProof(logs, before.bootId, Number(await before.shell("date", "+%s")))
      alreadyCurrent = proof.version === target.bes
    }
    if (
      !alreadyCurrent &&
      !values.resume &&
      (before.bootId !== fixture.before.bootId || before.slot !== fixture.before.slot)
    )
      throw new Error("Initial boot or slot differs from the reviewed fixture")
    await observe("Verify the app's OTA pin and exact fixture identity before any installation.", await snapshot())
    if (!values.resume) {
      const initialPage = otaPage(await snapshot())
      if (initialPage.kind === "offered") {
        const ok = await executeSteps(
          [
            {
              id: `OTA-${String(++index).padStart(2, "0")}`,
              instruction: "Defer the update offer briefly to verify the paired device.",
              expected: "The offer closes without starting installation.",
              action: {op: "press", selector: {role: "AXButton", description: "Later"}},
              checks: [{selector: {role: "AXButton", description: "Install"}, absent: true}],
            },
          ],
          {fixture: fixture.serial, email: "", password: ""},
          report,
        )
        if (!ok) throw new Error("Could not reach home for pairing verification")
      } else if (initialPage.kind !== "home")
        throw new Error("Start a new OTA routine at paired home or its initial update offer")
      await verifyAppPair()
      if (values.install && !alreadyCurrent) {
        const ok = await executeSteps(
          [
            {
              id: `OTA-${String(++index).padStart(2, "0")}`,
              instruction: "Relaunch the same signed app to repeat its normal update check.",
              expected: "The same app relaunches; the observer handles home, checking and update offers.",
              action: {op: "relaunch"},
              checks: [],
              timeoutMs: 20000,
            },
          ],
          {fixture: fixture.serial, email: "", password: ""},
          report,
        )
        if (!ok) throw new Error("Same-build OTA check relaunch failed")
      }
    }
    const deadline = performance.now() + minutes * 60000
    let lastPage = ""
    let unknownSince = performance.now()
    let lastHardwareCheck = performance.now()
    while (performance.now() < deadline) {
      const state = await snapshot()
      const page = otaPage(state)
      if (page.title !== lastPage) {
        await observe(`Observe OTA: ${page.title || "transitioning"}.`, state)
        console.log(`OTA: ${page.kind} — ${page.title}`)
        lastPage = page.title
      }
      if (page.kind === "failed") throw new Error(`OTA stopped on ${page.title}; app and glasses left untouched`)
      if (page.kind === "complete" || page.kind === "current" || (page.kind === "home" && alreadyCurrent && !started)) {
        await verifyTarget()
        if (page.kind !== "home")
          await press(
            page.kind === "complete" ? "button-Done" : "button-Continue",
            "Finish the verified update and return to paired home.",
          )
        if (otaPage(await snapshot()).kind !== "home") throw new Error("Verified update did not return to home")
        if (values.resume || started) await verifyAppPair()
        report.metadata.otaOutcome = started ? "updated" : values.resume ? "resumed-and-verified" : "already-current"
        finished = true
        break
      }
      if (page.kind === "pass-complete") {
        if (!started && !values.resume)
          throw new Error("An existing update completed; use --resume to finish observing it")
        await press(page.finishControl!, "Finish this installation pass and let the app check for remaining updates.")
      } else if (page.kind === "offered") {
        if (!values.install || values.resume)
          throw new Error("An update is offered; --install is required to start a new update")
        const ok = await executeSteps(
          [
            {
              id: `OTA-${String(++index).padStart(2, "0")}`,
              instruction: "Open the offered Mentra Live update.",
              expected: "Update Now is available.",
              action: {op: "press", selector: {role: "AXButton", description: "Install", enabled: true}},
              checks: [{selector: {identifier: "button-Update Now", enabled: true}}],
              timeoutMs: 30000,
            },
          ],
          {fixture: fixture.serial, email: "", password: ""},
          report,
        )
        if (!ok) throw new Error("Update offer did not open")
      } else if (page.kind === "available") {
        if (!values.install || values.resume) throw new Error("--install is required to start an update pass")
        // Match the app's eight-pass auto-chain bound; every pass retains the same pinned targets.
        if (installPasses >= 8) throw new Error("Pinned OTA sequence exceeded eight installation passes")
        if (legacy) await verifyPublishedLegacyManifests(legacy.route.manifests)
        await hardware()
        started = true
        report.metadata.installPasses = ++installPasses
        await press(
          "button-Update Now",
          `Start pass ${installPasses} of the pinned OTA sequence through the Mentra App.`,
        )
      } else if (page.kind === "working") {
        if (!started && !values.resume) throw new Error("An existing update is active; use --resume to observe it")
      }
      if (page.kind !== "unknown") unknownSince = performance.now()
      else if (performance.now() - unknownSince > 60000)
        throw new Error("Unrecognized OTA screen persisted for 60 seconds")
      if (performance.now() - lastHardwareCheck > 5000) {
        await observeOtaHardware(
          () => hardware((started || values.resume) && ["working", "checking", "pass-complete"].includes(page.kind)),
          (error) =>
            appendFile(
              join(hardwareFolder, "timeline.jsonl"),
              JSON.stringify({
                at: new Date().toISOString(),
                observation:
                  error.kind === "transport"
                    ? "Selected ADB transport unavailable during update"
                    : "Glasses boot in progress",
                error: String(error),
              }) + "\n",
              {mode: 0o600},
            ),
        )
        lastHardwareCheck = performance.now()
      }
      await Bun.sleep(750)
    }
    if (!finished) throw new Error("OTA observation deadline reached; installation was not interrupted or retried")
  }
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
        passed: finished && otaPage(await snapshot()).kind === "home",
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
      if (!finished || customerError)
        return {
          ...observation("verified customer sequence", {finished, error: customerError ?? null}),
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
              return {finished, installPasses}
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
                customerError || !finished ? "failed" : "incomplete",
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
  if (logger && logger.exitCode === null) {
    logger.kill()
    await logger.exited
  }
  await release()
}
