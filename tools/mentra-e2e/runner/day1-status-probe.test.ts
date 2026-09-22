import {expect, test} from "bun:test"
import {createHash, randomUUID} from "node:crypto"
import {writeSync} from "node:fs"
import {chmod, mkdtemp, realpath, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {
  createDay1StatusProbeStep,
  DAY1_STATUS_PROBE_REMOTE,
  type Day1StatusProbeInputs,
  type Day1StatusProbeProcesses,
} from "./day1-status-probe"
import {PROBE_BYTES, PROBE_SHA} from "./return-collector"
import type {LifecycleContext, MutationIntent} from "./lifecycle"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
async function fixture(body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "mentra-status-probe-")))
  try {
    await body(await setup(folder))
  } finally {
    await rm(folder, {recursive: true, force: true})
  }
}
async function setup(folder: string) {
  const adb = join(folder, "adb"),
    probe = join(folder, "probe.jar"),
    leasePath = join(folder, "lease.json")
  await writeFile(adb, "synthetic-adb")
  await chmod(adb, 0o755)
  await writeFile(probe, "not the real jar")
  await writeFile(leasePath, JSON.stringify({pid: process.pid, token: randomUUID()}), {mode: 0o600})
  const inputs: Day1StatusProbeInputs = {
    id: "stage-status-probe",
    adb: {path: adb, sha256: hash("synthetic-adb")},
    probe: {path: probe, sha256: PROBE_SHA, size: PROBE_BYTES},
    leasePath,
    fixture: {usb: "TESTUSB", serial: "TESTSERIAL", cid: "a".repeat(32), bluetooth: "AA:BB:CC:DD:EE:FF"},
    allowed: [{firmware: "MentraLive_20260921.0", asgVersion: 303001234, apkSha256: "b".repeat(64)}],
  }
  const state = {
    remoteKind: "absent",
    remoteSha: PROBE_SHA,
    remoteSize: PROBE_BYTES,
    safe: true,
    boot: randomUUID(),
    cid: inputs.fixture.cid,
    mac: inputs.fixture.bluetooth,
    failPush: false,
    failedPushLeavesBytes: true,
    probeHash: PROBE_SHA,
    safeChangesIdentity: false,
  }
  const calls: string[][] = [],
    writes: string[][] = []
  const runtime: Day1StatusProbeProcesses = {
    fingerprint: async (path) => ({
      sha256: path === adb ? inputs.adb.sha256 : state.probeHash,
      size: path === adb ? 13 : PROBE_BYTES,
      executable: path === adb,
    }),
    spawn({argv, stdout, stderr}) {
      const a = argv.slice(1)
      calls.push(a)
      let text = "",
        code = 0
      if (a[0] === "devices") text = "List of devices attached\nTESTSERIAL device usb:TESTUSB transport_id:5\n"
      else if (a[2] === "push") {
        writes.push(a)
        if (!state.failPush || state.failedPushLeavesBytes) state.remoteKind = "file"
        if (state.failPush) code = 1
      } else if (a[2] === "shell") {
        const s = a.slice(3).join(" ")
        if (s === "cat /sys/block/mmcblk0/device/cid") text = state.cid
        else if (s === "getprop ro.serialno" || s === "getprop ro.boot.serialno") text = inputs.fixture.serial
        else if (s === "getprop persist.mentra.live.mac") text = state.mac
        else if (s === "getprop ro.custom.ota.version") text = inputs.allowed[0]!.firmware
        else if (s === "getprop sys.boot_completed") text = "1"
        else if (s === "cat /proc/sys/kernel/random/boot_id") text = state.boot
        else if (s === "getprop ro.boot.slot_suffix") text = "_a"
        else if (s === "dumpsys package com.mentra.asg_client") text = "versionCode=303001234"
        else if (s === "pidof com.mentra.asg_client") text = "1234"
        else if (s === "cat /proc/1234/stat") text = `1234 (asg) S ${Array(18).fill("0").join(" ")} 123456`
        else if (s === "pm path com.mentra.asg_client") text = "package:/data/app/synthetic/base.apk"
        else if (s === "sha256sum /data/app/synthetic/base.apk")
          text = `${inputs.allowed[0]!.apkSha256}  /data/app/synthetic/base.apk`
        else if (s.startsWith("if [ -L ")) text = state.remoteKind
        else if (s === `sha256sum ${DAY1_STATUS_PROBE_REMOTE}`) text = `${state.remoteSha}  ${DAY1_STATUS_PROBE_REMOTE}`
        else if (s === `stat -c %s ${DAY1_STATUS_PROBE_REMOTE}`) text = String(state.remoteSize)
        else throw new Error(`Unexpected synthetic read: ${s}`)
      } else throw new Error(`Unexpected synthetic argv: ${a.join(" ")}`)
      writeSync(stdout, text)
      if (code) writeSync(stderr, "synthetic failure")
      return {pid: process.pid + 100, exited: Promise.resolve(code)}
    },
  }
  const safety = {
    assertSafeToChange: async () => {
      if (!state.safe) throw new Error("Active OTA writer")
      if (state.safeChangesIdentity) state.boot = randomUUID()
      return {evidence: [join(folder, "fresh-source-idle.json")]}
    },
  }
  const step = createDay1StatusProbeStep(inputs, safety, runtime)
  const context: LifecycleContext = {
    runDirectory: folder,
    selection: {runID: "test-run", fixtureID: "test-fixture", returnProfileDigest: "test", inputs: null},
    operations: [],
  }
  function intent() {
    const operation: MutationIntent = {
      operationID: randomUUID(),
      stepID: step.id,
      phase: "setup",
      startedAt: new Date().toISOString(),
    }
    ;(context.operations as MutationIntent[]).push(operation)
    return operation
  }
  return {folder, inputs, state, runtime, safety, calls, writes, step, context, intent}
}

test("one owned push stages the exact global SHA path and observes its bytes", () =>
  fixture(async (f) => {
    expect(f.calls).toHaveLength(0)
    expect((await f.step.reconcile(f.context)).status).toBe("settled")
    const owner = f.intent()
    await f.step.execute(f.context, owner)
    expect(f.writes).toEqual([["-t", "5", "push", f.inputs.probe.path, DAY1_STATUS_PROBE_REMOTE]])
    expect((await f.step.reconcile(f.context, owner)).status).toBe("satisfied")
    await expect(f.step.execute(f.context, owner)).rejects.toThrow("already claimed")
    expect(f.writes).toHaveLength(1)
  }))

test("an existing correct file is read-only, while unknown bytes and symlinks are rejected", () =>
  fixture(async (f) => {
    f.state.remoteKind = "file"
    expect((await f.step.reconcile(f.context)).status).toBe("satisfied")
    f.state.remoteSha = "c".repeat(64)
    expect((await f.step.reconcile(f.context)).status).toBe("unknown")
    f.state.remoteKind = "symlink"
    expect((await f.step.reconcile(f.context)).status).toBe("unknown")
    expect(f.writes).toHaveLength(0)
  }))

test("a failed push with independently matching bytes can reconcile but never repeat", () =>
  fixture(async (f) => {
    await f.step.reconcile(f.context)
    f.state.failPush = true
    const owner = f.intent()
    await expect(f.step.execute(f.context, owner)).rejects.toThrow()
    const recovered = createDay1StatusProbeStep(f.inputs, f.safety, f.runtime)
    expect((await recovered.reconcile(f.context, owner)).status).toBe("satisfied")
    await expect(recovered.execute(f.context, owner)).rejects.toThrow("already claimed")
    expect(f.writes).toHaveLength(1)
  }))

test("missing bytes after an ambiguous push remain unknown", () =>
  fixture(async (f) => {
    await f.step.reconcile(f.context)
    f.state.failPush = true
    f.state.failedPushLeavesBytes = false
    const owner = f.intent()
    await expect(f.step.execute(f.context, owner)).rejects.toThrow()
    expect((await f.step.reconcile(f.context, owner)).status).toBe("unknown")
    await expect(f.step.execute(f.context, owner)).rejects.toThrow()
    expect(f.writes).toHaveLength(1)
  }))

test("active writer or identity change between safety proof and dispatch prevents push", () =>
  fixture(async (f) => {
    await f.step.reconcile(f.context)
    f.state.safe = false
    const owner = f.intent()
    await expect(f.step.execute(f.context, owner)).rejects.toThrow("Active OTA writer")
    f.state.safe = true
    f.state.safeChangesIdentity = true
    await expect(f.step.execute(f.context, owner)).rejects.toThrow("changed across dispatch")
    expect(f.writes).toHaveLength(0)
  }))

test("changed local probe and missing lease fail before any adb call", () =>
  fixture(async (f) => {
    f.state.probeHash = "c".repeat(64)
    expect((await f.step.reconcile(f.context)).status).toBe("unknown")
    expect(f.calls).toHaveLength(0)
    f.state.probeHash = PROBE_SHA
    await writeFile(f.inputs.leasePath, JSON.stringify({pid: process.pid + 1, token: "other"}), {mode: 0o600})
    expect((await f.step.reconcile(f.context)).status).toBe("unknown")
    expect(f.calls).toHaveLength(0)
  }))

test("the production fingerprint rejects a synthetic local JAR without spawning adb", () =>
  fixture(async (f) => {
    const actual = createDay1StatusProbeStep(f.inputs, f.safety)
    const observation = await actual.reconcile(f.context)
    expect(observation.status).toBe("unknown")
    expect(observation.actual).toEqual({error: "Error: Pinned diagnostic probe changed"})
  }))

test("another lifecycle owner cannot adopt an earlier pushed file", () =>
  fixture(async (f) => {
    await f.step.reconcile(f.context)
    const owner = f.intent()
    await f.step.execute(f.context, owner)
    const other = {...owner, operationID: randomUUID()}
    expect((await f.step.reconcile({...f.context, operations: [other]}, other)).status).toBe("unknown")
    expect(f.writes).toHaveLength(1)
  }))
