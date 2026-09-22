/** Owned normal ASG Wi-Fi ADB preference setup/return. No firmware, shell props,
 * adbd restarts, root, address scanning, or automatic repeat of a write. */
import {createHash, randomUUID} from "node:crypto"
import {constants} from "node:fs"
import {mkdir, open, realpath} from "node:fs/promises"
import {dirname, isAbsolute, join, normalize} from "node:path"
import {isDeepStrictEqual} from "node:util"
import {OtaCommandError, readOtaHardware} from "./ota-hardware"
import {OtaHardwareUnavailable, assertWifiEndpoint} from "./ota-state"
import type {Json, LifecycleContext, MutationIntent, MutationStep, Reconciliation} from "./lifecycle"

type Pin = {path: string; sha256: string}
export interface WifiAdbInputs {
  id: string
  adb: Pin
  leasePath: string
  fixture: {usb: string; serial: string; cid: string; bluetooth: string; wifiEndpoint: string}
  allowed: {firmware: string; asgVersion: number; apkSha256: string}[]
}
export interface WifiAdbState {
  transport: string
  serial: string
  bootSerial: string
  cid: string
  bluetooth: string
  firmware: string
  bootId: string
  slot: string
  asgVersion: number
  apkPath: string
  apkSha256: string
  pid: string
  startTicks: string
  port: "-1" | "5555"
  ip: string | null
}
export interface WifiAdbSafety {
  /** Trusted live firmware-idle proof. It must throw unless changing the ADB
   * connection is currently safe; engine IDLE alone is not all-writer idle. */
  assertSafeToChange(context: LifecycleContext, current: Readonly<WifiAdbState>): Promise<{evidence: string[]}>
}
export interface WifiAdbProcesses {
  spawn(input: {argv: string[]; stdout: number; stderr: number}): {pid: number; exited: Promise<number>}
  sleep(ms: number): Promise<unknown>
}
const production: WifiAdbProcesses = {
  spawn: (input) => Bun.spawn(input.argv, {stdin: "ignore", stdout: input.stdout, stderr: input.stderr}),
  sleep: Bun.sleep,
}
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const shaPattern = /^[a-f0-9]{64}$/
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value))
function absolute(path: string) {
  if (!isAbsolute(path) || normalize(path) !== path || /[\0\r\n]/.test(path))
    throw new Error("Expected normalized absolute path")
  return path
}
async function read(path: string, privateFile = true) {
  const file = await open(absolute(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.size > (privateFile ? 8 : 64) * 1024 * 1024 ||
      (privateFile && (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1))
    )
      throw new Error("Invalid owned evidence file")
    return await file.readFile()
  } finally {
    await file.close()
  }
}
async function optional(path: string) {
  try {
    return JSON.parse((await read(path)).toString())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}
async function writeOnce(path: string, value: unknown) {
  const file = await open(path, "wx", 0o600)
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n")
    await file.sync()
  } finally {
    await file.close()
  }
  const parent = await open(dirname(path), "r")
  try {
    await parent.sync()
  } finally {
    await parent.close()
  }
}

export function createWifiAdbSteps(
  inputs: WifiAdbInputs,
  safety: WifiAdbSafety,
  runtime: WifiAdbProcesses = production,
): {enable: MutationStep; restore: MutationStep} {
  const selected = structuredClone(inputs)
  if (
    !/^[a-z][a-z0-9-]{0,59}$/.test(selected.id) ||
    !shaPattern.test(selected.adb.sha256) ||
    !selected.allowed.length ||
    selected.allowed.some(
      (p) => !p.firmware || !Number.isSafeInteger(p.asgVersion) || p.asgVersion < 1 || !shaPattern.test(p.apkSha256),
    )
  )
    throw new Error("Invalid Wi-Fi ADB adapter inputs")
  absolute(selected.adb.path)
  absolute(selected.leasePath)
  const fixture = selected.fixture
  if (
    !/^[a-f0-9]{32}$/i.test(fixture.cid) ||
    !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(fixture.bluetooth) ||
    !/^[A-Za-z0-9_-]+$/.test(fixture.serial) ||
    !/^[A-Za-z0-9_.:-]+$/.test(fixture.usb)
  )
    throw new Error("Invalid exact fixture identity")
  assertWifiEndpoint(fixture.wifiEndpoint)
  const [expectedIp, port] = fixture.wifiEndpoint.split(":")
  const octets = expectedIp!.split(".").map(Number)
  if (
    port !== "5555" ||
    !(
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    )
  )
    throw new Error("Expected selected private Wi-Fi endpoint at port 5555")
  const inputsSha256 = sha(JSON.stringify(selected))
  const ids = {enable: `${selected.id}-enable`, restore: `${selected.id}-restore`}
  function bound(context: LifecycleContext, kind: keyof typeof ids, intent?: Readonly<MutationIntent>) {
    const operations = context.operations.filter((item) => item.stepID === ids[kind])
    if (
      operations.length > 1 ||
      (operations.length && !intent) ||
      (intent &&
        (!uuid.test(intent.operationID) ||
          operations[0]?.operationID !== intent.operationID ||
          intent.stepID !== ids[kind] ||
          intent.phase !== (kind === "enable" ? "setup" : "teardown")))
    )
      throw new Error("Wi-Fi ADB requires its exact lifecycle intent")
    return join(absolute(context.runDirectory), "wifi-adb", selected.id)
  }
  async function lease() {
    const value = JSON.parse((await read(selected.leasePath)).toString())
    if (value.pid !== process.pid || typeof value.token !== "string" || !value.token)
      throw new Error("Wi-Fi ADB requires the caller's live lease")
    if (
      (await realpath(selected.adb.path)) !== selected.adb.path ||
      sha(await read(selected.adb.path, false)) !== selected.adb.sha256
    )
      throw new Error("Pinned adb changed")
  }
  async function prepare(folder: string) {
    await lease()
    await mkdir(folder, {recursive: true, mode: 0o700})
    const frozen = await optional(join(folder, "inputs.json"))
    if (frozen === undefined) await writeOnce(join(folder, "inputs.json"), selected)
    else if (!isDeepStrictEqual(frozen, selected)) throw new Error("Wi-Fi ADB inputs changed")
  }
  async function command(folder: string, args: string[], evidence: string[], allowError = false) {
    await lease()
    const directory = join(folder, `command-${randomUUID()}`)
    await mkdir(directory, {mode: 0o700})
    const argv = [selected.adb.path, ...args]
    const stdout = await open(join(directory, "stdout.txt"), "wx", 0o600),
      stderr = await open(join(directory, "stderr.txt"), "wx", 0o600)
    await writeOnce(join(directory, "started.json"), {argv, inputsSha256, startedAt: new Date().toISOString()})
    let exitCode: number | null = null,
      failure: string | null = null
    try {
      const child = runtime.spawn({argv, stdout: stdout.fd, stderr: stderr.fd})
      const exited = child.exited.then(
        (code) => ({code}),
        (error) => ({error}),
      )
      if (!Number.isSafeInteger(child.pid) || child.pid < 2) throw new Error("Invalid adb child PID")
      await writeOnce(join(directory, "spawned.json"), {pid: child.pid})
      const result = await exited
      if ("error" in result) throw result.error
      exitCode = result.code
    } catch (error) {
      failure = String(error)
    } finally {
      await stdout.sync()
      await stderr.sync()
      await stdout.close()
      await stderr.close()
      await writeOnce(join(directory, "result.json"), {exitCode, failure, finishedAt: new Date().toISOString()})
      evidence.push(directory)
    }
    if (!allowError && (exitCode !== 0 || failure)) throw new OtaCommandError("Recorded ADB command failed")
    return (await read(join(directory, "stdout.txt"))).toString().trim()
  }
  async function observe(
    folder: string,
    evidence: string[],
    network = false,
    requireEndpoint = true,
  ): Promise<WifiAdbState> {
    const run = (argv: string[]) => command(folder, argv.slice(1), evidence)
    const hardware = await readOtaHardware(
      network
        ? {serial: fixture.serial, cid: fixture.cid, bluetooth: fixture.bluetooth, wifiEndpoint: fixture.wifiEndpoint}
        : {serial: fixture.serial, cid: fixture.cid, bluetooth: fixture.bluetooth, usb: fixture.usb},
      selected.allowed.map((p) => p.firmware),
      selected.allowed.map((p) => p.asgVersion),
      false,
      run,
    )
    const shell = hardware.shell
    if (!uuid.test(hardware.bootId) || hardware.bootCompleted !== "1" || !["_a", "_b"].includes(hardware.slot))
      throw new Error("Incomplete source boot identity")
    const bootSerial = await shell("getprop", "ro.boot.serialno")
    const pid = await shell("pidof", "com.mentra.asg_client")
    if (bootSerial !== fixture.serial || !/^[1-9]\d*$/.test(pid)) throw new Error("ASG process or boot serial mismatch")
    const ticks = async () => {
      const stat = await shell("cat", `/proc/${pid}/stat`)
      const value = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/)[19]
      if (!value || !/^\d+$/.test(value)) throw new Error("Missing ASG process start time")
      return value
    }
    const startTicks = await ticks()
    const path = await shell("pm", "path", "com.mentra.asg_client")
    if (!/^package:\/[^\s]+\.apk$/.test(path)) throw new Error("Ambiguous ASG APK path")
    const apkPath = path.slice(8),
      apkSha256 = (await shell("sha256sum", apkPath)).split(/\s+/)[0]!
    if (
      !selected.allowed.some(
        (p) => p.firmware === hardware.firmware && p.asgVersion === hardware.asgVersion && p.apkSha256 === apkSha256,
      )
    )
      throw new Error("Unqualified ASG command implementation")
    const currentPort = await shell("getprop", "persist.adb.tcp.port")
    if (currentPort !== "-1" && currentPort !== "5555") throw new Error("Unsupported original Wi-Fi ADB setting")
    const wlan = requireEndpoint ? await shell("ip", "-o", "-4", "addr", "show", "wlan0") : ""
    const addresses = [...wlan.matchAll(/\binet (\d+(?:\.\d+){3})\/\d+\b/g)].map((m) => m[1])
    if (requireEndpoint && (addresses.length !== 1 || addresses[0] !== expectedIp))
      throw new Error("Selected endpoint differs from fresh fixture wlan0 address")
    if (
      (await shell("cat", "/proc/sys/kernel/random/boot_id")) !== hardware.bootId ||
      (await shell("pidof", "com.mentra.asg_client")) !== pid ||
      (await ticks()) !== startTicks ||
      (await shell("cat", "/sys/block/mmcblk0/device/cid")).toLowerCase() !== fixture.cid.toLowerCase()
    )
      throw new Error("Source changed during observation")
    const {shell: _shell, bootCompleted: _boot, ...identity} = hardware
    return {
      ...identity,
      bootSerial,
      apkPath,
      apkSha256,
      pid,
      startTicks,
      port: currentPort,
      ip: requireEndpoint ? expectedIp! : null,
    }
  }
  function sameSource(before: WifiAdbState, after: WifiAdbState) {
    const {transport: _a, port: _p, ...a} = before,
      {transport: _b, port: _q, ...b} = after
    if (!isDeepStrictEqual(a, b)) throw new Error("Source changed before configuration write")
  }
  async function original(folder: string, current?: WifiAdbState) {
    const path = join(folder, "original.json")
    let value = await optional(path)
    if (value === undefined && current) {
      value = {inputsSha256, observedAt: new Date().toISOString(), current}
      await writeOnce(path, value)
    }
    if (
      value !== undefined &&
      (value.inputsSha256 !== inputsSha256 ||
        !["-1", "5555"].includes(value.current?.port) ||
        !uuid.test(value.current?.bootId))
    )
      throw new Error("Invalid original Wi-Fi ADB state")
    return value as {inputsSha256: string; observedAt: string; current: WifiAdbState} | undefined
  }
  function step(kind: "enable" | "restore"): MutationStep {
    return {
      id: ids[kind],
      kind: "mutation",
      repeat: "never",
      instruction:
        kind === "enable"
          ? "Enable owned Wi-Fi ADB on the identified glasses"
          : "Restore the original Wi-Fi ADB setting on the identified glasses",
      async reconcile(context, intent) {
        const folder = bound(context, kind, intent),
          evidence: string[] = []
        try {
          await prepare(folder)
          let saved = await original(folder)
          if (!saved && context.operations.some((item) => item.stepID === ids.enable))
            throw new Error("Original setup evidence is missing")
          if (kind === "restore" && !saved) return answer("satisfied", {noSetupObservation: true}, evidence)
          const dispatch = await optional(join(folder, `${kind}-dispatch.json`))
          if (
            dispatch &&
            (!intent ||
              dispatch.owner !== intent.operationID ||
              dispatch.inputsSha256 !== inputsSha256 ||
              dispatch.originalSha256 !== sha(await read(join(folder, "original.json"))))
          )
            throw new Error("Configuration dispatch ownership changed")
          const current = await observe(folder, evidence, false, kind === "enable")
          if (!saved) saved = await original(folder, current)
          const target = kind === "enable" ? "5555" : saved!.current.port
          if (kind === "enable") sameSource(saved!.current, current)
          if (current.port === target) {
            let connected = true
            if (kind === "enable") {
              try {
                sameSource(current, await observe(folder, evidence, true))
              } catch (error) {
                if (!(error instanceof OtaHardwareUnavailable)) throw error
                connected = false
              }
            }
            if (connected) return answer("satisfied", {current, original: saved, target}, evidence)
          }
          if (intent || dispatch)
            return answer("unknown", {current, target, reason: "Original dispatch cannot be repeated"}, evidence)
          const proof = await safety.assertSafeToChange(context, current)
          evidence.push(...proof.evidence)
          return answer("settled", {current, original: saved, target}, evidence)
        } catch (error) {
          return answer("unknown", {error: String(error)}, evidence)
        }
      },
      async execute(context, intent) {
        const folder = bound(context, kind, intent),
          evidence: string[] = []
        await prepare(folder)
        const saved = await original(folder)
        if (!saved) throw new Error("Missing original Wi-Fi ADB observation")
        const initial = await observe(folder, evidence, false, kind === "enable")
        if (kind === "enable") sameSource(saved.current, initial)
        const target = kind === "enable" ? "5555" : saved.current.port
        const proof = await safety.assertSafeToChange(context, initial)
        evidence.push(...proof.evidence)
        const guarded = await observe(folder, evidence, false, kind === "enable")
        sameSource(initial, guarded)
        if (guarded.port !== initial.port) throw new Error("Wi-Fi setting changed before dispatch")
        const dispatchPath = join(folder, `${kind}-dispatch.json`)
        await writeOnce(dispatchPath, {
          owner: intent.operationID,
          inputsSha256,
          originalSha256: sha(await read(join(folder, "original.json"))),
          current: guarded,
          target,
          evidence,
          startedAt: new Date().toISOString(),
        })
        if (guarded.port !== target) {
          const body = JSON.stringify({type: "set_wifi_adb_state", enabled: target === "5555"})
          await command(
            folder,
            [
              "-t",
              guarded.transport,
              "shell",
              `am broadcast -n com.mentra.asg_client/.receiver.IntentCommandReceiver -a com.mentra.asg_client.ACTION_SEND_COMMAND --es json ${quote(body)}`,
            ],
            evidence,
            true,
          )
        }
        // Observation may follow re-enumeration. No broadcast is sent twice.
        const deadline = Date.now() + 30_000
        let current: WifiAdbState
        for (;;) {
          try {
            current = await observe(folder, evidence, false, kind === "enable")
            sameSource(guarded, current)
            if (current.port === target) break
          } catch (error) {
            if (!(error instanceof OtaHardwareUnavailable)) throw error
          }
          if (Date.now() >= deadline) throw new Error("Original Wi-Fi ADB write did not settle")
          await runtime.sleep(500)
        }
        if (kind === "enable") {
          const beforeConnect = await observe(folder, evidence)
          sameSource(current, beforeConnect)
          await writeOnce(join(folder, "connect-intent.json"), {
            owner: intent.operationID,
            inputsSha256,
            endpoint: fixture.wifiEndpoint,
            current: beforeConnect,
            at: new Date().toISOString(),
          })
          await command(folder, ["connect", fixture.wifiEndpoint], evidence, true)
          sameSource(beforeConnect, await observe(folder, evidence, true))
        }
        const result = {
          owner: intent.operationID,
          inputsSha256,
          target,
          current,
          evidence,
          finishedAt: new Date().toISOString(),
        }
        await writeOnce(join(folder, `${kind}-result.json`), result)
        return json(result)
      },
    }
  }
  function answer(status: Reconciliation["status"], actual: unknown, evidence: string[]): Reconciliation {
    return {
      status,
      expected: json({fixture: selected.fixture, allowed: selected.allowed}),
      actual: json(actual),
      observedAt: new Date().toISOString(),
      source: "owned-wifi-adb-preference",
      evidence,
    }
  }
  return {enable: step("enable"), restore: step("restore")}
}
