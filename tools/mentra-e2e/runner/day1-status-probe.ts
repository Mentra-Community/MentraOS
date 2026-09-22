/** Bootstrap the existing read-only status probe. The normal January observer
 * uses this same SHA-named path after POWERWASH; this step never installs code,
 * executes the probe, restarts adbd, or changes firmware. */
import {createHash, randomUUID} from "node:crypto"
import {constants} from "node:fs"
import {mkdir, open, realpath} from "node:fs/promises"
import {dirname, isAbsolute, join, normalize} from "node:path"
import {isDeepStrictEqual} from "node:util"
import {OtaCommandError, readOtaHardware} from "./ota-hardware"
import {PROBE_BYTES, PROBE_SHA} from "./return-collector"
import type {Json, LifecycleContext, MutationIntent, MutationStep, Reconciliation} from "./lifecycle"

type Pin = {path: string; sha256: string}
export const DAY1_STATUS_PROBE_REMOTE = `/data/local/tmp/mentra-update-engine-status-${PROBE_SHA}.jar`
export interface Day1StatusProbeInputs {
  id: string
  adb: Pin
  probe: Pin & {size: number}
  leasePath: string
  fixture: {usb: string; serial: string; cid: string; bluetooth: string}
  allowed: {firmware: string; asgVersion: number; apkSha256: string}[]
}
export interface Day1StatusProbeState {
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
}
/** Trusted local runtime/test seam, never selected by CI request data. */
export interface Day1StatusProbeProcesses {
  spawn(input: {argv: string[]; stdout: number; stderr: number}): {pid: number; exited: Promise<number>}
  fingerprint(path: string): Promise<{sha256: string; size: number; executable: boolean}>
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const shaPattern = /^[a-f0-9]{64}$/
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
function absolute(path: string) {
  if (!isAbsolute(path) || normalize(path) !== path || /[\0\r\n]/.test(path))
    throw new Error("Expected normalized absolute path")
  return path
}
async function privateBytes(path: string) {
  const file = await open(absolute(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.size > 8 * 1024 * 1024 ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600
    )
      throw new Error("Invalid owned probe evidence")
    return await file.readFile()
  } finally {
    await file.close()
  }
}
const production: Day1StatusProbeProcesses = {
  spawn: (input) => Bun.spawn(input.argv, {stdin: "ignore", stdout: input.stdout, stderr: input.stderr}),
  async fingerprint(path) {
    if ((await realpath(path)) !== path) throw new Error("Pinned probe/tool path contains symlinks")
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await file.stat()
      if (!before.isFile()) throw new Error("Expected pinned regular file")
      const digest = createHash("sha256")
      for await (const chunk of file.createReadStream({autoClose: false})) digest.update(chunk)
      const after = await file.stat()
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
        throw new Error("Pinned file changed while hashing")
      return {sha256: digest.digest("hex"), size: before.size, executable: !!(before.mode & 0o111)}
    } finally {
      await file.close()
    }
  },
}
async function writeOnce(path: string, value: unknown) {
  const file = await open(path, "wx", 0o600)
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n")
    await file.sync()
  } finally {
    await file.close()
  }
  const directory = await open(dirname(path), "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}
async function optional(path: string) {
  try {
    return JSON.parse((await privateBytes(path)).toString())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}
const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value))

export function createDay1StatusProbeStep(
  inputs: Day1StatusProbeInputs,
  safety: {
    assertSafeToChange(
      context: LifecycleContext,
      current: Readonly<Day1StatusProbeState>,
    ): Promise<{evidence: string[]}>
  },
  runtime: Day1StatusProbeProcesses = production,
): MutationStep {
  const selected = structuredClone(inputs)
  if (
    !/^[a-z][a-z0-9-]{0,79}$/.test(selected.id) ||
    !shaPattern.test(selected.adb.sha256) ||
    selected.probe.sha256 !== PROBE_SHA ||
    selected.probe.size !== PROBE_BYTES ||
    !selected.allowed.length ||
    selected.allowed.some(
      (item) =>
        !item.firmware ||
        !Number.isSafeInteger(item.asgVersion) ||
        item.asgVersion < 1 ||
        !shaPattern.test(item.apkSha256),
    )
  )
    throw new Error("Invalid diagnostic probe configuration")
  for (const path of [selected.adb.path, selected.probe.path, selected.leasePath]) absolute(path)
  const fixture = selected.fixture
  if (
    !/^[a-f0-9]{32}$/i.test(fixture.cid) ||
    !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(fixture.bluetooth) ||
    !/^[A-Za-z0-9_-]+$/.test(fixture.serial) ||
    !/^[A-Za-z0-9_.:-]+$/.test(fixture.usb)
  )
    throw new Error("Invalid exact fixture identity")
  const inputsSha256 = hash(JSON.stringify(selected))
  function bound(context: LifecycleContext, intent?: Readonly<MutationIntent>) {
    const matches = context.operations.filter((item) => item.stepID === selected.id)
    if (
      matches.length > 1 ||
      (matches.length && !intent) ||
      (intent &&
        (!uuid.test(intent.operationID) ||
          matches[0]?.operationID !== intent.operationID ||
          intent.stepID !== selected.id ||
          intent.phase !== "setup"))
    )
      throw new Error("Probe staging requires its original setup intent")
    return join(absolute(context.runDirectory), "day1-status-probe", selected.id)
  }
  async function lease() {
    const value = JSON.parse((await privateBytes(selected.leasePath)).toString())
    if (value.pid !== process.pid || typeof value.token !== "string" || !value.token)
      throw new Error("Probe staging requires caller's current lease")
    const actual = await runtime.fingerprint(selected.adb.path)
    if (actual.sha256 !== selected.adb.sha256 || !actual.executable) throw new Error("Pinned ADB executable changed")
  }
  async function prepare(folder: string) {
    await lease()
    const actual = await runtime.fingerprint(selected.probe.path)
    if (actual.sha256 !== PROBE_SHA || actual.size !== PROBE_BYTES) throw new Error("Pinned diagnostic probe changed")
    await mkdir(folder, {recursive: true, mode: 0o700})
    const old = await optional(join(folder, "inputs.json"))
    if (old === undefined) await writeOnce(join(folder, "inputs.json"), selected)
    else if (!isDeepStrictEqual(old, selected)) throw new Error("Probe inputs changed during recovery")
  }
  async function command(folder: string, args: string[], evidence: string[]) {
    await lease()
    const directory = join(folder, `command-${randomUUID()}`)
    await mkdir(directory, {mode: 0o700})
    const argv = [selected.adb.path, ...args],
      stdout = await open(join(directory, "stdout.txt"), "wx", 0o600),
      stderr = await open(join(directory, "stderr.txt"), "wx", 0o600)
    await writeOnce(join(directory, "started.json"), {argv, inputsSha256, startedAt: new Date().toISOString()})
    let code: number | null = null,
      failure: string | null = null
    try {
      const child = runtime.spawn({argv, stdout: stdout.fd, stderr: stderr.fd})
      const exited = child.exited.then(
        (code) => ({code}),
        (error) => ({error}),
      )
      if (!Number.isSafeInteger(child.pid) || child.pid < 2) throw new Error("Invalid ADB process identity")
      await writeOnce(join(directory, "spawned.json"), {pid: child.pid})
      const result = await exited
      if ("error" in result) throw result.error
      code = result.code
    } catch (error) {
      failure = String(error)
    } finally {
      await stdout.sync()
      await stderr.sync()
      await stdout.close()
      await stderr.close()
      await writeOnce(join(directory, "result.json"), {code, failure, finishedAt: new Date().toISOString()})
      evidence.push(directory)
    }
    const text = (await privateBytes(join(directory, "stdout.txt"))).toString().trim()
    if (code !== 0 || failure) throw new OtaCommandError("Recorded probe ADB command failed")
    return text
  }
  async function identity(folder: string, evidence: string[]): Promise<Day1StatusProbeState> {
    const hardware = await readOtaHardware(
      fixture,
      selected.allowed.map((p) => p.firmware),
      selected.allowed.map((p) => p.asgVersion),
      false,
      (argv) => command(folder, argv.slice(1), evidence),
    )
    if (!uuid.test(hardware.bootId) || hardware.bootCompleted !== "1" || !["_a", "_b"].includes(hardware.slot))
      throw new Error("Incomplete probe source identity")
    const bootSerial = await hardware.shell("getprop", "ro.boot.serialno"),
      pid = await hardware.shell("pidof", "com.mentra.asg_client")
    if (bootSerial !== fixture.serial || !/^[1-9]\d*$/.test(pid))
      throw new Error("Probe source process/serial mismatch")
    const ticks = async () => {
      const stat = await hardware.shell("cat", `/proc/${pid}/stat`)
      return stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/)[19]!
    }
    const startTicks = await ticks()
    if (!/^\d+$/.test(startTicks)) throw new Error("Missing ASG start time")
    const path = await hardware.shell("pm", "path", "com.mentra.asg_client")
    if (!/^package:\/[^\s]+\.apk$/.test(path)) throw new Error("Ambiguous active ASG APK")
    const apkPath = path.slice(8),
      apkSha256 = (await hardware.shell("sha256sum", apkPath)).split(/\s+/)[0]!
    if (
      !selected.allowed.some(
        (p) => p.firmware === hardware.firmware && p.asgVersion === hardware.asgVersion && p.apkSha256 === apkSha256,
      )
    )
      throw new Error("Unqualified probe source APK")
    if (
      (await hardware.shell("cat", "/proc/sys/kernel/random/boot_id")) !== hardware.bootId ||
      (await hardware.shell("pidof", "com.mentra.asg_client")) !== pid ||
      (await ticks()) !== startTicks ||
      (await hardware.shell("cat", "/sys/block/mmcblk0/device/cid")).toLowerCase() !== fixture.cid.toLowerCase()
    )
      throw new Error("Probe source changed during observation")
    const {shell: _shell, bootCompleted: _boot, ...state} = hardware
    return {...state, bootSerial, pid, startTicks, apkPath, apkSha256}
  }
  function same(a: Day1StatusProbeState, b: Day1StatusProbeState) {
    const {transport: _a, ...before} = a,
      {transport: _b, ...after} = b
    if (!isDeepStrictEqual(before, after)) throw new Error("Probe source changed across dispatch")
  }
  async function remote(folder: string, state: Day1StatusProbeState, evidence: string[]) {
    const path = DAY1_STATUS_PROBE_REMOTE
    // Explicit output distinguishes absent from command failure. Symlinks,
    // directories and unknown existing bytes are never overwritten.
    const kind = await command(
      folder,
      [
        "-t",
        state.transport,
        "shell",
        `if [ -L ${path} ]; then echo symlink; elif [ -f ${path} ]; then echo file; elif [ -e ${path} ]; then echo other; else echo absent; fi`,
      ],
      evidence,
    )
    if (kind === "absent") return false
    if (kind !== "file") throw new Error("Unknown existing probe path")
    const digest = (await command(folder, ["-t", state.transport, "shell", "sha256sum", path], evidence)).split(
      /\s+/,
    )[0]
    const size = await command(folder, ["-t", state.transport, "shell", "stat", "-c", "%s", path], evidence)
    if (digest !== PROBE_SHA || size !== String(PROBE_BYTES)) throw new Error("Unknown existing probe bytes")
    return true
  }
  function answer(status: Reconciliation["status"], actual: unknown, evidence: string[]): Reconciliation {
    return {
      status,
      expected: {path: DAY1_STATUS_PROBE_REMOTE, sha256: PROBE_SHA, size: PROBE_BYTES},
      actual: asJson(actual),
      observedAt: new Date().toISOString(),
      source: "owned-read-only-status-probe",
      evidence,
    }
  }
  return {
    id: selected.id,
    kind: "mutation",
    repeat: "never",
    instruction: "Stage the pinned read-only OTA status probe on the identified glasses",
    async reconcile(context, intent) {
      const folder = bound(context, intent),
        evidence: string[] = []
      try {
        await prepare(folder)
        const dispatch = await optional(join(folder, "push-intent.json"))
        if (dispatch && (!intent || dispatch.owner !== intent.operationID || dispatch.inputsSha256 !== inputsSha256))
          throw new Error("Probe dispatch ownership changed")
        const before = await identity(folder, evidence),
          exists = await remote(folder, before, evidence),
          after = await identity(folder, evidence)
        same(before, after)
        if (exists) return answer("satisfied", {identity: after, existingVerifiedProbe: true}, evidence)
        if (intent || dispatch)
          return answer("unknown", {identity: after, reason: "Original probe push cannot be repeated"}, evidence)
        const proof = await safety.assertSafeToChange(context, after)
        evidence.push(...proof.evidence)
        return answer("settled", {identity: after, absent: true}, evidence)
      } catch (error) {
        return answer("unknown", {error: String(error)}, evidence)
      }
    },
    async execute(context, intent) {
      const folder = bound(context, intent),
        evidence: string[] = []
      await prepare(folder)
      if (await optional(join(folder, "push-intent.json"))) throw new Error("Probe push already claimed; do not resend")
      const before = await identity(folder, evidence)
      const proof = await safety.assertSafeToChange(context, before)
      evidence.push(...proof.evidence)
      const guarded = await identity(folder, evidence)
      same(before, guarded)
      if (await remote(folder, guarded, evidence))
        throw new Error("Probe already present; reconcile without overwriting")
      const probe = await runtime.fingerprint(selected.probe.path)
      if (probe.sha256 !== PROBE_SHA || probe.size !== PROBE_BYTES) throw new Error("Probe changed before push")
      await writeOnce(join(folder, "push-intent.json"), {
        owner: intent.operationID,
        inputsSha256,
        source: guarded,
        remote: DAY1_STATUS_PROBE_REMOTE,
        sha256: PROBE_SHA,
        size: PROBE_BYTES,
        at: new Date().toISOString(),
        evidence,
      })
      await command(folder, ["-t", guarded.transport, "push", selected.probe.path, DAY1_STATUS_PROBE_REMOTE], evidence)
      const after = await identity(folder, evidence)
      same(guarded, after)
      if (!(await remote(folder, after, evidence))) throw new Error("Pushed probe not independently present")
      const result = {
        owner: intent.operationID,
        inputsSha256,
        source: guarded,
        after,
        remote: DAY1_STATUS_PROBE_REMOTE,
        sha256: PROBE_SHA,
        size: PROBE_BYTES,
        evidence,
        finishedAt: new Date().toISOString(),
      }
      await writeOnce(join(folder, "result.json"), result)
      return asJson(result)
    },
  }
}
