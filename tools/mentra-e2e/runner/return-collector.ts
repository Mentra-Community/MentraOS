import {createHash, randomUUID} from "node:crypto"
import {readFile} from "node:fs/promises"
import {join} from "node:path"
import {
  assertFirmwareState,
  firmwareTransport,
  normalizeBesVersion,
  type FirmwareObservation,
  type FirmwareProfile,
} from "./firmware-profile"
import {readOtaHardware, type OtaFixture} from "./ota-hardware"
import {normalizeFirmware} from "./ota-state"
import {
  checkRuntimeOtaIdle,
  checkStoppedStream,
  processStartTicks,
  type ReturnProcess,
  type ReturnRead,
} from "./return-observer"

// Reviewed read-only UpdateEngineStatus tool; never accept an arbitrary executable JAR.
export const PROBE_SHA = "c0488244fe62e24f0ca2c855355de01bc687d1d8ae762336e2fc0405e5e42a8e"
export const PROBE_BYTES = 2143
const PROBE_NAME = `mentra-update-engine-status-${PROBE_SHA}.jar`
const APP = "com.mentra.asg_client"
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object")
  return value as Record<string, unknown>
}

export type ReturnCommandCapture = {
  startedAt: string
  finishedAt: string
  argv: string[]
  exitCode: number
  stdout: string
  evidence: string
}

/** The owner supplies a new private evidence directory and a recorder that fsyncs
 * command intents/results, rejects nonzero or timed-out commands, and exclusively
 * creates evidence files. Raw command output stays local, outside published reports. */
export interface ReturnEvidenceRecorder {
  readonly output: string
  capture(argv: string[]): Promise<ReturnCommandCapture>
  run(argv: string[]): Promise<string>
  file(name: string, value: string | Uint8Array): Promise<string>
  json(name: string, value: unknown): Promise<string>
  append(value: unknown): Promise<void>
}

export type ReturnCollectorConfig = {
  /** Already frozen with parseFirmwareProfile after producer/artifact verification. */
  profile: FirmwareProfile
  fixture: OtaFixture
  probe: {path: string; sha256: string; size: number}
  recorder: ReturnEvidenceRecorder
  /** Explicit known source versions for a repair observation. Target assertions
   * still compare the unchanged profile and cannot pass an off-target device. */
  allowedSource?: {mtkVersions: string[]; asgVersions: number[]; besVersions: string[]}
}

export function validateFixture(value: unknown): OtaFixture {
  const row = object(value)
  const transport = firmwareTransport(row)
  if (
    typeof row.serial !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(row.serial) ||
    typeof row.cid !== "string" ||
    !/^[a-f0-9]{32}$/i.test(row.cid) ||
    typeof row.bluetooth !== "string" ||
    !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(row.bluetooth)
  )
    throw new Error("Fixture must name the physical transport, serial, full CID and full Bluetooth MAC")
  return {...transport, serial: row.serial, cid: row.cid.toLowerCase(), bluetooth: row.bluetooth.toUpperCase()}
}

export function validateProbePath(path: string): string {
  if (
    path !== `/data/local/tmp/${PROBE_NAME}` &&
    !new RegExp(`^/data/local/tmp/mentra-return-probe-[a-f0-9]{32}/${PROBE_NAME.replaceAll(".", "\\.")}$`).test(path)
  )
    throw new Error("Probe path must be the pinned SHA-named JAR, optionally in its fresh owned directory")
  return path
}

export type LogRow = {seconds: number; pid: number; tag: string; message: string}
export function logRows(text: string): LogRow[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+\.\d+)\s+(\d+)\s+\d+\s+[VDIWEFA]\s+([^:]+):\s?(.*)$/.exec(line)
    return match ? [{seconds: Number(match[1]), pid: Number(match[2]), tag: match[3].trim(), message: match[4]}] : []
  })
}

export function exactJsonResponse(
  rows: LogRow[],
  pid: number,
  tag: string,
  prefix: string,
  earliest: number,
  latest: number,
  matches: (value: Record<string, unknown>) => boolean,
) {
  const found = rows
    .filter(
      (row) =>
        row.pid === pid &&
        row.tag === tag &&
        row.message.startsWith(prefix) &&
        row.seconds >= earliest &&
        row.seconds <= latest,
    )
    .flatMap((row) => {
      const value = object(JSON.parse(row.message.slice(prefix.length)))
      return matches(value) ? [{row, value}] : []
    })
  if (found.length !== 1) throw new Error(`Expected exactly one fresh ${tag} response; observed ${found.length}`)
  return found[0]
}

/** BaseBluetoothManager publishes the actual response through this release-level
 * trace. Queue metrics, router input and debug-only service messages are not replies. */
export function exactBleOutputResponse(
  rows: LogRow[],
  pid: number,
  type: "version_info_1" | "stream_status",
  earliest: number,
  latest: number,
  matches: (value: Record<string, unknown>) => boolean,
) {
  const prefix = `BLE_TRACE direction=glasses_to_phone layer=asg_ble_output source=asg_client type=${type} bytes=`
  const output = rows.flatMap((row) => {
    if (row.tag !== "MentraBleTrace" || !row.message.startsWith(prefix)) return []
    const payload = /^[1-9]\d* payload=(\{.*\})$/.exec(row.message.slice(prefix.length))
    return payload ? [{...row, message: payload[1]}] : []
  })
  return exactJsonResponse(
    output,
    pid,
    "MentraBleTrace",
    "",
    earliest,
    latest,
    (value) => value.type === type && matches(value),
  )
}

export function freshBes(rows: LogRow[], process: ReturnProcess, expected: string | string[], maxAgeSeconds: number) {
  const candidates = rows
    .filter(
      (row) =>
        row.pid === process.pid &&
        row.tag === "K900BluetoothManager" &&
        row.seconds >= Number(process.startTicks) / process.clockTicksPerSecond &&
        row.seconds <= process.uptimeSeconds,
    )
    .flatMap((row) => {
      const found = /^BES_OTA_DIAG version_proof actual=(\d+(?:\.\d+){3}) current_boot=([a-f0-9-]{36})\b/.exec(
        row.message,
      )
      return found && found[2] === process.bootId ? [{row, version: found[1]}] : []
    })
    .sort((a, b) => a.row.seconds - b.row.seconds)
  const latest = candidates.at(-1)
  if (!latest || process.uptimeSeconds - latest.row.seconds > maxAgeSeconds) return undefined
  const allowed = (Array.isArray(expected) ? expected : [expected]).map(normalizeBesVersion)
  if (!allowed.includes(normalizeBesVersion(latest.version)))
    throw new Error(`Fresh BES target mismatch: ${latest.version}`)
  return latest
}

export type AppContext = {recorder: ReturnEvidenceRecorder; profile: FirmwareProfile; fixture: OtaFixture}
export type AppProof = {connected: boolean; evidence: string; capturedAt: string[]}
export type AppObserver = {
  prepare(context: AppContext): Promise<void>
  capture(context: AppContext): Promise<AppProof>
  finish(context: AppContext, proof: AppProof): Promise<AppProof>
}
export function appProofWithinBracket(proof: AppProof, before: string, after: string, now: number) {
  return (
    proof.connected === true &&
    proof.evidence.trim().length > 0 &&
    proof.capturedAt.length >= 3 &&
    proof.capturedAt.every(
      (at) =>
        Number.isFinite(Date.parse(at)) &&
        Date.parse(at) >= Date.parse(before) &&
        Date.parse(at) <= Date.parse(after) &&
        now >= Date.parse(at) &&
        now - Date.parse(at) <= 30000,
    )
  )
}
/** Collect under the caller's existing global harness lease. This action body
 * never acquires/releases a lease, stages tools, changes firmware or writes fixture
 * ownership. A passing observation is not a lifecycle handover or prior test pass. */
export async function collectReturnObservation(config: ReturnCollectorConfig, app?: AppObserver) {
  const fixture = validateFixture(config.fixture)
  const profile = structuredClone(config.profile)
  const allowed = structuredClone(
    config.allowedSource ?? {
      mtkVersions: [profile.mtk.version],
      asgVersions: [profile.asg.versionCode],
      besVersions: [profile.bes.version],
    },
  )
  if (
    !allowed ||
    ![allowed.mtkVersions, allowed.asgVersions, allowed.besVersions].every(
      (values) => Array.isArray(values) && values.length > 0 && values.length <= 32,
    ) ||
    !allowed.asgVersions.every((value) => Number.isSafeInteger(value) && value > 0)
  )
    throw new Error("Explicit bounded source versions are required")
  allowed.mtkVersions = allowed.mtkVersions.map(normalizeFirmware)
  allowed.besVersions = allowed.besVersions.map(normalizeBesVersion)
  const {recorder} = config
  const output = recorder.output
  const remote = validateProbePath(config.probe.path)
  if (config.probe.sha256 !== PROBE_SHA || config.probe.size !== PROBE_BYTES)
    throw new Error("Return observation requires the reviewed status probe")
  await recorder.json("inputs.json", {
    mode: "collect",
    fixture,
    profile,
    allowedSource: allowed,
    probe: config.probe,
    collectorSha256: sha(await readFile(import.meta.path)),
    returnObserverSha256: sha(await readFile(new URL("./return-observer.ts", import.meta.url))),
  })
  try {
    const appContext = {recorder, profile, fixture}
    await app?.prepare(appContext)
    const hardware = () =>
      readOtaHardware(fixture, allowed.mtkVersions, allowed.asgVersions, false, (argv) => recorder.run(argv))
    const initial = await hardware()
    if (initial.bootCompleted !== "1" || !/^_[ab]$/.test(initial.slot)) throw new Error("Target has not completed boot")
    const shell = (...argv: string[]) => ["adb", "-t", initial.transport, "shell", ...argv]
    const sameHardware = async () => {
      const next = await hardware()
      if (
        next.transport !== initial.transport ||
        next.bootId !== initial.bootId ||
        next.slot !== initial.slot ||
        next.firmware !== initial.firmware ||
        next.asgVersion !== initial.asgVersion
      )
        throw new Error("Fixture transport, boot or slot changed during observation")
      return next
    }
    if (
      (await recorder.run(shell("test", "!", "-L", remote))) !== "" ||
      (await recorder.run(shell("sha256sum", remote))).split(/\s+/)[0] !== PROBE_SHA ||
      (await recorder.run(shell("stat", "-c", "%s", remote))) !== String(PROBE_BYTES)
    )
      throw new Error("Installed probe mismatch")
    const processRead = async (name: string): Promise<ReturnRead<null>> => {
      const bootId = await recorder.run(shell("cat", "/proc/sys/kernel/random/boot_id"))
      const pidRaw = await recorder.run(shell("pidof", APP))
      if (!/^[1-9]\d*$/.test(pidRaw)) throw new Error("Expected one ASG process")
      const pid = Number(pidRaw)
      const ticks = processStartTicks(await recorder.run(shell("cat", `/proc/${pid}/stat`)), pid)
      const frequency = Number(await recorder.run(shell("getconf", "CLK_TCK")))
      const uptime = await recorder.capture(shell("cat", "/proc/uptime"))
      const process = {
        bootId,
        pid,
        startTicks: ticks,
        clockTicksPerSecond: frequency,
        uptimeSeconds: Number(uptime.stdout.split(/\s+/)[0]),
      }
      if (
        bootId !== initial.bootId ||
        !Number.isFinite(frequency) ||
        frequency <= 0 ||
        !Number.isFinite(process.uptimeSeconds)
      )
        throw new Error("Invalid process observation")
      const at = uptime.finishedAt
      const evidence = await recorder.json(name, {at, process})
      return {at, process, evidence, value: null}
    }
    const waitIdentity = await processRead("waiting-process.json")
    const logRead = async () => {
      const log = await recorder.capture(
        shell("logcat", "-b", "main", "-d", "-v", "threadtime", "-v", "monotonic", "-v", "usec"),
      )
      const uptime = Number((await recorder.run(shell("cat", "/proc/uptime"))).split(/\s+/)[0])
      if (!Number.isFinite(uptime)) throw new Error("Invalid log capture uptime")
      return {log, uptime, rows: logRows(log.stdout)}
    }
    // Wait only for the existing periodic hardware version reply, never send a fake MCU event.
    let bes: {version: string; at: string; bootId: string; evidence: string} | undefined
    const deadline = Date.now() + 35000
    while (!bes) {
      const logs = await logRead()
      const found = freshBes(logs.rows, {...waitIdentity.process, uptimeSeconds: logs.uptime}, allowed.besVersions, 15)
      if (found)
        bes = {
          version: found.version,
          bootId: initial.bootId,
          evidence: logs.log.evidence,
          at: new Date(Date.parse(logs.log.startedAt) - (logs.uptime - found.row.seconds) * 1000).toISOString(),
        }
      else if (Date.now() >= deadline) throw new Error("No fresh same-boot hardware BES reply")
      else await Bun.sleep(2000)
    }
    const before = await processRead("before.json")
    if (
      before.process.pid !== waitIdentity.process.pid ||
      before.process.startTicks !== waitIdentity.process.startTicks
    )
      throw new Error("ASG changed while waiting for its hardware proof")
    let appProof = await app?.capture(appContext)
    const current = await sameHardware()
    const apkPaths = (await recorder.run(shell("pm", "path", APP))).split(/\r?\n/)
    if (
      apkPaths.length !== 1 ||
      !/^package:\/(?:data\/app|system\/app|system\/priv-app)\/[A-Za-z0-9_./=+~-]+\.apk$/.test(apkPaths[0]) ||
      apkPaths[0].split("/").some((part) => part === "." || part === "..")
    )
      throw new Error("Expected one safe active APK path")
    const apkPath = apkPaths[0].slice("package:".length)
    const activeApkSha256 = (await recorder.run(shell("sha256sum", apkPath))).split(/\s+/)[0]
    if (!/^[a-f0-9]{64}$/.test(activeApkSha256)) throw new Error("Invalid active APK SHA")
    const engine = await recorder.capture(
      shell(`CLASSPATH=${quote(remote)} app_process /system/bin UpdateEngineStatus`),
    )
    const engineUptime = Number((await recorder.run(shell("cat", "/proc/uptime"))).split(/\s+/)[0])
    const updateEngine: ReturnRead<string> = {
      at: engine.finishedAt,
      evidence: engine.evidence,
      process: {...before.process, uptimeSeconds: engineUptime},
      value: engine.stdout,
    }
    const versionId = `return-version-${randomUUID().replaceAll("-", "")}`
    const activityId = `return-activity-${randomUUID().replaceAll("-", "")}`
    const query = (value: unknown) =>
      recorder.capture(
        shell(
          "am broadcast -n " +
            APP +
            "/.receiver.IntentCommandReceiver -a " +
            APP +
            ".ACTION_SEND_COMMAND --es json " +
            quote(JSON.stringify(value)),
        ),
      )
    await query({type: "request_version", request_id: versionId})
    const streamStart = Number((await recorder.run(shell("cat", "/proc/uptime"))).split(/\s+/)[0])
    await query({type: "get_stream_status"})
    await query({type: "ota_query_status", include_activity: true, request_id: activityId})
    let response: Awaited<ReturnType<typeof logRead>> | undefined
    let version: ReturnType<typeof exactJsonResponse> | undefined
    let activity: ReturnType<typeof exactJsonResponse> | undefined
    let stream: ReturnType<typeof exactJsonResponse> | undefined
    for (let attempt = 0; attempt < 6; attempt++) {
      response = await logRead()
      try {
        version = exactBleOutputResponse(
          response.rows,
          before.process.pid,
          "version_info_1",
          before.process.uptimeSeconds,
          response.uptime,
          (row) => row.request_id === versionId,
        )
        activity = exactJsonResponse(
          response.rows,
          before.process.pid,
          "OtaCommandHandler",
          "OTA activity snapshot: ",
          before.process.uptimeSeconds,
          response.uptime,
          (row) => row.request_id === activityId,
        )
        stream = exactBleOutputResponse(
          response.rows,
          before.process.pid,
          "stream_status",
          streamStart,
          response.uptime,
          (row) => row.kind === "snapshot",
        )
        break
      } catch (error) {
        if (attempt === 5) throw error
        await Bun.sleep(250) // Read-only response wait; queries are never resent.
      }
    }
    if (!response || !version || !activity || !stream) throw new Error("Missing query response")
    if (
      version.value.type !== "version_info_1" ||
      version.value.package_name !== APP ||
      Number(version.value.build_number) !== initial.asgVersion ||
      typeof version.value.sid !== "string"
    )
      throw new Error("Version response does not match selected ASG")
    const snapshotRead: ReturnRead<unknown> = {
      at: response.log.finishedAt,
      evidence: response.log.evidence,
      process: {...before.process, uptimeSeconds: response.uptime},
      value: activity.value,
    }
    if (app && appProof) appProof = await app.finish(appContext, appProof)
    const after = await processRead("after.json")
    await sameHardware()
    const now = Date.now()
    const idleInput = {
      before,
      after,
      activity: snapshotRead,
      updateEngine,
      requestId: activityId,
      currentProcessSid: version.value.sid,
    }
    const idleChecks = checkRuntimeOtaIdle(idleInput, now)
    const streamStopped = checkStoppedStream(stream.value, version.value.sid)
    const observation: Partial<FirmwareObservation> = {
      ...firmwareTransport(fixture),
      at: after.at,
      evidence: join(output, "observation.json"),
      serial: current.serial,
      cid: current.cid,
      bluetooth: current.bluetooth,
      bootId: current.bootId,
      bootCompleted: current.bootCompleted === "1",
      firmware: current.firmware,
      asgVersion: current.asgVersion,
      activeApkSha256,
      bes,
      updateIdle: idleChecks.every((check) => check.passed),
      ...(appProof ? {appConnected: appProofWithinBracket(appProof, before.at, after.at, now)} : {}),
    }
    await recorder.json("observation.json", observation)
    await recorder.json("runtime-idle-input.json", idleInput)
    await recorder.json("stream.json", {
      value: stream.value,
      evidence: response.log.evidence,
      currentProcessSid: version.value.sid,
      streamStopped,
    })
    const assertions = assertFirmwareState(
      profile,
      {...firmwareTransport(fixture), cid: fixture.cid, bluetooth: fixture.bluetooth, serials: [fixture.serial]},
      observation,
      now,
    )
    const result = {
      mode: "collect" as const,
      finishedAt: new Date(now).toISOString(),
      scope: app
        ? "Timed ADB and selected-app return observation; no fixture state mutation"
        : "ADB-only return observation; no app connectivity or fixture-ready claim",
      appConnection: appProof ? (observation.appConnected ? "observed-connected" : "failed") : "not-observed",
      fixtureStateChanged: false,
      returnObservationPassed:
        !!appProof &&
        streamStopped &&
        idleChecks.every((check) => check.passed) &&
        assertions.every((check) => check.status === "passed"),
      ...(!app ? {fullFixtureReturnQualified: false} : {appEvidence: appProof?.evidence}),
      adbQualified:
        streamStopped &&
        idleChecks.every((check) => check.passed) &&
        assertions.filter((check) => check.id !== "app.connected").every((check) => check.status === "passed"),
      slot: current.slot,
      apkPath,
      idleChecks,
      streamStopped,
      firmwareAssertions: assertions,
    }
    await recorder.json("result.json", result)
    return result
  } catch (error) {
    await recorder.json("failure.json", {
      finishedAt: new Date().toISOString(),
      error: String(error),
      fullFixtureReturnQualified: false,
    })
    throw error
  }
}
