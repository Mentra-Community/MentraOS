import {afterEach, expect, mock, test} from "bun:test"
import {mkdtemp, readFile, rm, stat} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import type {Snapshot} from "./driver"
import {OTA_AUDIO_NOTICE_BODY, OTA_AUDIO_NOTICE_TITLE} from "./ota-audio-notice"
import {legacyAppPairChecks} from "./ota-legacy-route"
import {createOtaRecording, otaRecordingSelection, type OtaRecordingInputs} from "./ota-recording"
import {OtaHardwareUnavailable, OtaValidationError} from "./ota-state"
import type {Report} from "./report"
import type {Step} from "./suite"

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, {recursive: true, force: true})))
})
const sha = "a".repeat(64)
const fixture = {
  serial: "TEST012345",
  usb: "test-usb",
  cid: "0123456789abcdef0123456789abcdef",
  bluetooth: "AA:BB:CC:DD:EE:01",
  before: {firmware: "20260113", asgVersion: 27, bootId: "old-boot", slot: "_a"},
}
const bytes = () =>
  new TextEncoder().encode(
    JSON.stringify({
      apps: {"com.mentra.asg_client": {versionCode: 200, sha256: sha}},
      mtk_full_ota: {end_firmware: "20260921.0"},
      bes_firmware: {version: "26.9.21.3"},
    }),
  )
const home = {
  pid: 100,
  frontmostBundleId: "com.mentra.mentra",
  elements: [{identifier: "home.miniapp.com.mentra.settings", visible: true}],
} as Snapshot
const proof = "1000.500 10 10 I K: BES_OTA_DIAG version_proof actual=26.9.21.3 current_boot=new-boot"

async function harness(legacy = false) {
  const directory = await mkdtemp(join(tmpdir(), "ota-recording-"))
  folders.push(directory)
  const inputs: OtaRecordingInputs = {
    fixture: structuredClone(fixture),
    build: {otaManifestUrl: "https://example.test/ota.json"},
    manifestUrl: "https://example.test/ota.json",
    manifestBytes: bytes(),
    resume: false,
  }
  if (legacy)
    inputs.legacy = {
      route: {
        schemaVersion: 1,
        buildSha: "b".repeat(40),
        executableSha256: "c".repeat(64),
        manifestSha256: otaRecordingSelection(inputs.fixture, inputs.manifestBytes).manifestSha256,
        effectivePolicy: {path: "/verified/policy.json", sha256: sha, size: 10},
        sourceEvidence: [],
        artifacts: [],
        embeddedAsg: [],
        manifests: [{path: "/verified/legacy.json", url: "https://example.test/legacy.json", sha256: sha, size: 10}],
      },
      allowedFirmware: ["MentraLive_20260113", "MentraLive_20260709", "MentraLive_20260921.0"],
      allowedAsg: [27, 31, 100, 200],
    }
  const recorded: {id: string; status: string; videoStart?: number}[] = []
  const report = {
    directory,
    metadata: {existing: "outer lifecycle"},
    video: {mark: mock(async () => 12.5)},
    record: mock(async (step: (typeof recorded)[number]) => {
      recorded.push(step)
      return step
    }),
  } as unknown as Report
  const shell = mock(async (...args: string[]) => {
    if (args.join(" ") === "date +%s") return "1010"
    if (args.join(" ") === "pm path com.mentra.asg_client") return "package:/data/app/test/base.apk"
    if (args.join(" ") === "sha256sum /data/app/test/base.apk") return `${sha} /data/app/test/base.apk`
    throw new Error(`Unexpected shell command ${JSON.stringify(args)}`)
  })
  const identity = {
    transport: "7",
    serial: fixture.serial,
    cid: fixture.cid,
    bluetooth: fixture.bluetooth,
    firmware: "MentraLive_20260921.0",
    asgVersion: 200,
    bootId: "new-boot",
    slot: "_b",
    bootCompleted: "1",
    shell,
  }
  const loggers: {exitCode: number | null; kill: ReturnType<typeof mock>; exited: Promise<number>}[] = []
  const io = {
    snapshot: mock(async () => home),
    readHardware: mock(async (..._args: unknown[]) => ({...identity})),
    run: mock(async (_args: string[]) => proof),
    executeSteps: mock(async (_steps: Step[], _context: unknown, _report: Report) => true),
    verifyPublishedManifests: mock(async (_manifests: unknown) => {}),
    spawnLogger: mock((_transport: string, _path: string) => {
      const exited = Promise.withResolvers<number>()
      const logger = {
        exitCode: null as number | null,
        kill: mock(() => {
          logger.exitCode = 0
          exited.resolve(0)
        }),
        exited: exited.promise,
      }
      loggers.push(logger)
      return logger
    }),
  }
  const session = await createOtaRecording(report, inputs, io)
  return {session, report, inputs, io, identity, shell, loggers, recorded}
}

test("construction preserves frozen evidence without starting hardware, UI or another recording", async () => {
  const {session, inputs, report, io, loggers} = await harness()
  for (const operation of Object.values(io)) expect(operation).not.toHaveBeenCalled()
  expect(await readFile(join(session.hardwareFolder, "manifest.json"))).toEqual(Buffer.from(inputs.manifestBytes))
  expect((await stat(session.hardwareFolder)).mode & 0o777).toBe(0o700)
  expect(report.metadata.existing).toBe("outer lifecycle")
  expect(report.metadata.ota).toMatchObject({scope: "normal-update", nativeAssociationQualified: false})
  inputs.fixture.bluetooth = "00:00:00:00:00:00"
  inputs.manifestBytes.fill(0)
  await session.actions.hardware(true)
  expect(io.readHardware.mock.calls[0]).toEqual([
    fixture,
    ["MentraLive_20260113", "MentraLive_20260921.0"],
    [27, 200],
    true,
  ])
  await session.close()
  await session.close()
  expect(loggers[0].kill).toHaveBeenCalledTimes(1)
})

test("transport rotation waits for its owned logger and repeated observations do not duplicate segments", async () => {
  const {session, io, identity, loggers} = await harness()
  await session.actions.hardware()
  await session.actions.hardware()
  expect(io.spawnLogger).toHaveBeenCalledTimes(1)
  identity.transport = "8"
  io.spawnLogger.mockImplementation((transport, path) => {
    expect(loggers[0].exitCode).toBe(0)
    expect(transport).toBe("8")
    expect(path).toEndWith("transport-8-2-private.log")
    const logger = {
      exitCode: null as number | null,
      kill: mock(() => {
        logger.exitCode = 0
      }),
      exited: Promise.resolve(0),
    }
    loggers.push(logger)
    return logger
  })
  await session.actions.hardware()
  expect(loggers[0].kill).toHaveBeenCalledTimes(1)
  const timeline = (await readFile(join(session.hardwareFolder, "timeline.jsonl"), "utf8")).trim().split("\n")
  expect(timeline.map((line) => JSON.parse(line).transport)).toEqual(["7", "8"])
  await session.close()
  expect(loggers[1].kill).toHaveBeenCalledTimes(1)
})

test("legacy reads retain the strict allowlist during active passes and recheck the loaded feeds", async () => {
  const {session, inputs, io} = await harness(true)
  await session.actions.hardware(true)
  expect(io.readHardware.mock.calls[0][1]).toEqual(inputs.legacy!.allowedFirmware)
  expect(io.readHardware.mock.calls[0][2]).toEqual(inputs.legacy!.allowedAsg)
  expect(io.readHardware.mock.calls[0][3]).toBe(false)
  await session.actions.verifyPublishedManifests!()
  expect(io.verifyPublishedManifests).toHaveBeenCalledWith(inputs.legacy!.route.manifests)
  await session.actions.verifyAppPair()
  const pairSteps = io.executeSteps.mock.calls[0][0]
  expect(pairSteps[1].checks).toEqual(legacyAppPairChecks(fixture.bluetooth, 200))
  await session.close()
})

test("only proven transport downtime is recorded; identity failure remains fatal", async () => {
  const {session, io} = await harness()
  io.readHardware.mockImplementation(async () => {
    throw new OtaHardwareUnavailable("transport", "test disconnected")
  })
  await session.actions.observeHardware(true)
  expect(await readFile(join(session.hardwareFolder, "timeline.jsonl"), "utf8")).toContain(
    "Selected ADB transport unavailable",
  )
  io.readHardware.mockImplementation(async () => {
    throw new OtaValidationError("HARDWARE_BLUETOOTH_MISMATCH")
  })
  await expect(session.actions.observeHardware(true)).rejects.toThrow("HARDWARE_BLUETOOTH_MISMATCH")
  expect(io.spawnLogger).not.toHaveBeenCalled()
})

test("observation and actions use the same Report and unique chapters; a failed press is never retried", async () => {
  const {session, report, io, recorded} = await harness()
  await session.actions.observe("Observe the current screen.", home)
  await session.actions.executeStep({
    instruction: "One caller step",
    expected: "The current state is recorded.",
    action: {op: "snapshot"},
    checks: [],
  })
  io.executeSteps.mockResolvedValue(false)
  await expect(session.actions.press("button-Update Now", "Start the reviewed update.")).rejects.toThrow("do not retry")
  expect(recorded[0]).toMatchObject({id: "OTA-01", videoStart: 12.5, status: "passed"})
  expect(io.executeSteps.mock.calls.map(([steps]) => steps[0].id)).toEqual(["OTA-02", "OTA-03"])
  expect(io.executeSteps.mock.calls.every(([, , calledReport]) => calledReport === report)).toBe(true)
  expect(io.executeSteps.mock.calls[1][0][0]).toMatchObject({
    action: {op: "press", selector: {identifier: "button-Update Now", enabled: true}},
    checks: [{selector: {identifier: "button-Update Now"}, absent: true}],
    timeoutMs: 15000,
  })
  expect(io.executeSteps).toHaveBeenCalledTimes(2)
})

test("captured audio notice gets one named step before Settings, and a failed dismissal stops there", async () => {
  for (const dismisses of [true, false]) {
    const {session, io} = await harness()
    io.snapshot.mockResolvedValue({
      ...home,
      elements: [
        ...home.elements,
        ...[OTA_AUDIO_NOTICE_TITLE, OTA_AUDIO_NOTICE_BODY].map((description) => ({
          role: "AXStaticText",
          description,
          visible: true,
        })),
        ...["Ignore", "Connect"].map((description) => ({
          role: "AXButton",
          description,
          enabled: true,
          visible: true,
          actions: ["AXPress"],
        })),
      ],
    } as Snapshot)
    io.executeSteps.mockResolvedValue(dismisses)
    if (dismisses) {
      await session.actions.verifyAppPair()
      expect(io.executeSteps.mock.calls[1][0].map((step) => step.id)).toEqual(["OTA-02", "OTA-03", "OTA-04"])
      expect(io.executeSteps.mock.calls[1][0][1].checks).toEqual([
        {selector: {role: "AXGenericElement", contains: fixture.serial}},
        {selector: {role: "AXGenericElement", contains: fixture.bluetooth}},
      ])
    } else {
      await expect(session.actions.verifyAppPair()).rejects.toThrow("do not retry its dismissal")
      expect(io.executeSteps).toHaveBeenCalledTimes(1)
    }
    expect(io.executeSteps.mock.calls[0][0][0].instruction).toContain("Bluetooth audio")
  }
})

test("final qualification still requires the fresh boot BES response and exact installed APK bytes", async () => {
  for (const failure of ["firmware", "bes", "apk", "stale", "none"]) {
    const {session, io, identity, shell, recorded} = await harness(true)
    if (failure === "firmware") identity.firmware = "MentraLive_20260709"
    if (failure === "bes") io.run.mockResolvedValue(proof.replace("26.9.21.3", "26.9.20.1"))
    if (failure === "stale") io.run.mockResolvedValue(proof.replace("new-boot", "old-boot"))
    if (failure === "apk")
      shell.mockImplementation(async (...args) =>
        args[0] === "date" ? "1010" : args[0] === "pm" ? "package:/data/app/test/base.apk" : "b".repeat(64),
      )
    if (failure === "none") {
      await session.actions.verifyTarget()
      expect(JSON.parse(await readFile(join(session.hardwareFolder, "verified-target.json"), "utf8"))).toMatchObject({
        firmware: "MentraLive_20260921.0",
        asgVersion: 200,
        bes: {version: "26.9.21.3"},
        apkSha256: sha,
      })
      expect(recorded).toHaveLength(1)
    } else {
      await expect(session.actions.verifyTarget()).rejects.toThrow()
      expect(recorded).toHaveLength(0)
      expect(await Bun.file(join(session.hardwareFolder, "verified-target.json")).exists()).toBe(false)
    }
    expect(io.verifyPublishedManifests).toHaveBeenCalledTimes(1)
    await session.close()
  }
})
