import {createHash} from "node:crypto"
import {appendFile, chmod, mkdir, writeFile} from "node:fs/promises"
import {join} from "node:path"
import {snapshot, type Snapshot} from "./driver"
import {otaAudioNotice, otaAudioNoticeStep} from "./ota-audio-notice"
import type {OtaCustomerActions} from "./ota-customer-sequence"
import {observeOtaHardware, otaCommand, readOtaHardware, type OtaFixture} from "./ota-hardware"
import {legacyAppPairChecks, type loadLegacyRoute, verifyPublishedLegacyManifests} from "./ota-legacy-route"
import {freshBesProof, normalizeFirmware, otaFirmwareRoute} from "./ota-state"
import type {Report} from "./report"
import {executeSteps} from "./suite"

export type OtaRecordingFixture = OtaFixture & {
  before: {firmware: string; asgVersion: number; bootId: string; slot: string}
}
export type LoadedOtaLegacyRoute = Awaited<ReturnType<typeof loadLegacyRoute>>
export interface OtaRecordingInputs {
  fixture: OtaRecordingFixture
  /** The caller verifies the actual running app against this build before creating the session. */
  build: {otaManifestUrl: string}
  manifestBytes: Uint8Array
  manifestUrl: string
  /** Already loaded and hash-verified with loadLegacyRoute against these selected inputs. */
  legacy?: LoadedOtaLegacyRoute
  resume: boolean
}

/** Shared early CLI validation and the exact targets consumed by the recorded actions. */
export function otaRecordingSelection(fixture: OtaRecordingFixture, manifestBytes: Uint8Array) {
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes))
  const app = manifest.apps?.["com.mentra.asg_client"]
  const target = {
    asgVersion: app?.versionCode as number,
    asgSha256: app?.sha256 as string,
    firmware: normalizeFirmware(manifest.mtk_full_ota?.end_firmware),
    bes: manifest.bes_firmware?.version as string,
  }
  if (
    !Number.isInteger(target.asgVersion) ||
    !/^[a-f\d]{64}$/i.test(target.asgSha256 ?? "") ||
    !target.firmware ||
    !target.bes
  )
    throw new Error("Manifest must pin ASG, full MTK fallback and BES targets")
  return {
    manifest,
    target,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    allowedFirmware: otaFirmwareRoute(fixture.before.firmware, target.firmware, manifest.mtk_patches),
  }
}

type Logger = {exitCode: number | null; kill(): unknown; exited: Promise<number>}
export interface OtaRecordingIO {
  snapshot: typeof snapshot
  readHardware: typeof readOtaHardware
  run: typeof otaCommand
  executeSteps: typeof executeSteps
  verifyPublishedManifests: typeof verifyPublishedLegacyManifests
  spawnLogger(transport: string, path: string): Logger
}

/**
 * Recorded actions only: the caller holds the harness lease, starts/verifies the
 * Report and video, owns the lifecycle intent, and finalizes the report. Call
 * close in finally to stop only this session's logcat process. No installation,
 * snapshot, ADB read, lease acquisition or lifecycle starts during construction.
 */
export async function createOtaRecording(
  report: Report,
  inputs: OtaRecordingInputs,
  overrides: Partial<OtaRecordingIO> = {},
) {
  const frozen = structuredClone(inputs)
  const {fixture, legacy} = frozen
  const selection = otaRecordingSelection(fixture, frozen.manifestBytes)
  const {target, manifestSha256} = selection
  const allowedFirmware = legacy?.allowedFirmware ?? selection.allowedFirmware
  const allowedAsg = legacy?.allowedAsg ?? [fixture.before.asgVersion, target.asgVersion]
  if (frozen.build.otaManifestUrl !== frozen.manifestUrl)
    throw new Error("Build OTA pin differs from the requested manifest")
  const url = new URL(frozen.manifestUrl)
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("Expected a public HTTPS manifest URL")
  if (!report.directory) throw new Error("Start the caller-owned Report before creating OTA recording actions")
  const io: OtaRecordingIO = {
    snapshot,
    readHardware: readOtaHardware,
    run: otaCommand,
    executeSteps,
    verifyPublishedManifests: verifyPublishedLegacyManifests,
    spawnLogger: (transport, log) =>
      Bun.spawn(["adb", "-t", transport, "logcat", "-v", "epoch", "-T", "1"], {
        stdout: Bun.file(log),
        stderr: Bun.file(log + ".stderr"),
      }),
    ...overrides,
  }
  const hardwareFolder = join(report.directory, "hardware")
  await mkdir(hardwareFolder, {mode: 0o700})
  await writeFile(join(hardwareFolder, "manifest.json"), frozen.manifestBytes)
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
    resume: frozen.resume,
    nativeAssociationQualified: false,
  }
  let logger: Logger | undefined
  let loggingTransport = ""
  let logSegment = 0
  let index = 0
  let lastHardware = ""

  async function hardware(observingActivePass = false) {
    const {shell, ...state} = await io.readHardware(
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
      logger = io.spawnLogger(transport, log)
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
    const ok = await io.executeSteps(
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
    const notice = otaAudioNotice(await io.snapshot())
    if (notice === "blocked") throw new Error("The glasses audio notice is incomplete or ambiguous")
    if (notice === "dismissible") {
      const step = otaAudioNoticeStep(`OTA-${String(++index).padStart(2, "0")}`)
      if (!(await io.executeSteps([step], {fixture: fixture.serial, email: "", password: ""}, report)))
        throw new Error("The glasses audio notice did not close; do not retry its dismissal automatically")
    }
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
    if (!(await io.executeSteps(steps, {fixture: fixture.serial, email: "", password: ""}, report)))
      throw new Error("The app's paired device does not match the selected fixture")
  }
  async function verifyTarget() {
    if (legacy) await io.verifyPublishedManifests(legacy.route.manifests)
    const identity = await hardware()
    if (
      identity.firmware !== target.firmware ||
      identity.asgVersion !== target.asgVersion ||
      identity.bootCompleted !== "1"
    )
      throw new Error("App completion does not match the installed ASG and MTK targets")
    // This fixture returned empty tag-filtered dumps while the same live buffer
    // contained version responses. Bound the raw read, then select proofs locally.
    const logs = await io.run(["adb", "-t", identity.transport, "logcat", "-d", "-v", "epoch", "-t", "12000"])
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
      await io.snapshot(),
    )
  }

  const actions: OtaCustomerActions = {
    snapshot: io.snapshot,
    hardware,
    observe,
    press,
    verifyAppPair,
    verifyTarget,
    readBesVersion: async (identity) => {
      const logs = await io.run(["adb", "-t", identity.transport, "logcat", "-d", "-v", "epoch", "-t", "12000"])
      return freshBesProof(logs, identity.bootId, Number(await identity.shell("date", "+%s"))).version
    },
    executeStep: (step) =>
      io.executeSteps(
        [{...step, id: `OTA-${String(++index).padStart(2, "0")}`}],
        {fixture: fixture.serial, email: "", password: ""},
        report,
      ),
    verifyPublishedManifests: legacy ? () => io.verifyPublishedManifests(legacy.route.manifests) : undefined,
    observeHardware: async (observingActivePass) => {
      await observeOtaHardware(
        () => hardware(observingActivePass),
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
    },
  }
  return {
    actions,
    hardwareFolder,
    target,
    manifestSha256,
    allowedFirmware,
    allowedAsg,
    async close() {
      if (logger && logger.exitCode === null) {
        logger.kill()
        await logger.exited
      }
    },
  }
}
