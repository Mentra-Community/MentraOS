import {expect, test} from "bun:test"
import {createHash, randomUUID} from "node:crypto"
import {writeSync} from "node:fs"
import {chmod, mkdtemp, readFile, realpath, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {createWifiAdbSteps, type WifiAdbInputs, type WifiAdbProcesses} from "./wifi-adb"
import type {LifecycleContext, MutationIntent, MutationStep} from "./lifecycle"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
async function fixture(body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "wifi-adb-test-")))
  try {
    await body(await setup(folder))
  } finally {
    await rm(folder, {recursive: true, force: true})
  }
}
async function setup(folder: string) {
  const adb = join(folder, "adb"),
    leasePath = join(folder, "lease.json")
  await writeFile(adb, "synthetic-adb")
  await chmod(adb, 0o755)
  await writeFile(leasePath, JSON.stringify({pid: process.pid, token: randomUUID()}), {mode: 0o600})
  const inputs: WifiAdbInputs = {
    id: "owned-wifi",
    adb: {path: adb, sha256: hash("synthetic-adb")},
    leasePath,
    fixture: {
      usb: "123456X",
      serial: "TESTFIXTURE",
      cid: "a".repeat(32),
      bluetooth: "AA:BB:CC:DD:EE:FF",
      wifiEndpoint: "192.168.10.20:5555",
    },
    allowed: [{firmware: "MentraLive_20260921.0", asgVersion: 303001234, apkSha256: "b".repeat(64)}],
  }
  const state = {
    port: "-1",
    connected: false,
    cid: inputs.fixture.cid,
    mac: inputs.fixture.bluetooth,
    ip: "192.168.10.20",
    boot: randomUUID(),
    pid: "1234",
    ticks: "123456",
    safe: true,
    dropAfterBroadcast: false,
    foreignBroadcastOwner: false,
    throwAfterBroadcast: false,
  }
  const calls: string[][] = [],
    writes: string[][] = []
  const runtime: WifiAdbProcesses = {
    sleep: async () => {},
    spawn({argv, stdout, stderr}) {
      calls.push(argv.slice(1))
      let text = "",
        code = 0
      const a = argv.slice(1)
      if (a[0] === "devices")
        text = `List of devices attached\nTESTFIXTURE device usb:123456X transport_id:5\n${state.connected ? "192.168.10.20:5555 device transport_id:8\n" : ""}`
      else if (a[0] === "connect") {
        writes.push(a)
        state.connected = true
        text = "connected"
      } else if (a[2] === "shell") {
        const s = a.slice(3).join(" ")
        if (s.startsWith("am broadcast ")) {
          writes.push(a)
          state.port = s.includes('"enabled":true') ? "5555" : "-1"
          if (state.port === "-1") state.connected = false
          if (state.dropAfterBroadcast) state.cid = "c".repeat(32)
          if (state.throwAfterBroadcast) code = 1
          text = "Broadcast completed: result=0"
        } else if (s === "cat /sys/block/mmcblk0/device/cid") text = state.cid
        else if (s === "getprop ro.serialno" || s === "getprop ro.boot.serialno") text = inputs.fixture.serial
        else if (s === "getprop persist.mentra.live.mac") text = state.mac
        else if (s === "getprop ro.custom.ota.version") text = inputs.allowed[0]!.firmware
        else if (s === "getprop sys.boot_completed") text = "1"
        else if (s === "cat /proc/sys/kernel/random/boot_id") text = state.boot
        else if (s === "getprop ro.boot.slot_suffix") text = "_a"
        else if (s === "dumpsys package com.mentra.asg_client") text = "versionCode=303001234"
        else if (s === "pidof com.mentra.asg_client") text = state.pid
        else if (s === `cat /proc/${state.pid}/stat`)
          text = `${state.pid} (asg) S ${Array(18).fill("0").join(" ")} ${state.ticks}`
        else if (s === "pm path com.mentra.asg_client") text = "package:/data/app/synthetic/base.apk"
        else if (s === "sha256sum /data/app/synthetic/base.apk")
          text = `${inputs.allowed[0]!.apkSha256}  /data/app/synthetic/base.apk`
        else if (s === "getprop persist.adb.tcp.port") text = state.port
        else if (s === "ip -o -4 addr show wlan0") text = `1: wlan0 inet ${state.ip}/24 scope global wlan0`
        else throw new Error(`Unexpected fake shell: ${s}`)
      } else throw new Error(`Unexpected fake argv: ${a.join(" ")}`)
      writeSync(stdout, text)
      if (code) writeSync(stderr, "synthetic disconnect")
      return {pid: process.pid + 100, exited: Promise.resolve(code)}
    },
  }
  const safety = {
    assertSafeToChange: async () => {
      if (!state.safe) throw new Error("Active writer")
      return {evidence: [join(folder, "trusted-idle-proof.json")]}
    },
  }
  const steps = createWifiAdbSteps(inputs, safety, runtime)
  const context: LifecycleContext = {
    runDirectory: folder,
    selection: {runID: "synthetic-run", fixtureID: "test", returnProfileDigest: "x", inputs: null},
    operations: [],
  }
  function intent(step: MutationStep, phase: "setup" | "teardown") {
    const op: MutationIntent = {operationID: randomUUID(), stepID: step.id, phase, startedAt: new Date().toISOString()}
    ;(context.operations as MutationIntent[]).push(op)
    return op
  }
  return {folder, inputs, state, calls, writes, runtime, safety, steps, context, intent}
}

test("enable and restore reuse normal ASG commands exactly once with current identity", () =>
  fixture(async (f) => {
    expect((await f.steps.enable.reconcile(f.context)).status).toBe("settled")
    const owner = f.intent(f.steps.enable, "setup")
    await f.steps.enable.execute(f.context, owner)
    expect((await f.steps.enable.reconcile(f.context, owner)).status).toBe("satisfied")
    expect(f.writes.length).toBe(2)
    expect(f.writes[0]!.join(" ")).toContain('"type":"set_wifi_adb_state","enabled":true')
    expect(f.writes[1]).toEqual(["connect", f.inputs.fixture.wifiEndpoint])
    f.state.boot = randomUUID() // a later qualified modern target is allowed for teardown
    expect((await f.steps.restore.reconcile(f.context)).status).toBe("settled")
    const restore = f.intent(f.steps.restore, "teardown")
    await f.steps.restore.execute(f.context, restore)
    expect((await f.steps.restore.reconcile(f.context, restore)).status).toBe("satisfied")
    expect(f.writes.length).toBe(3)
    expect(f.state.port).toBe("-1")
    const original = JSON.parse(await readFile(join(f.folder, "wifi-adb/owned-wifi/original.json"), "utf8"))
    expect(original.current.port).toBe("-1")
  }))

test("pre-enabled setting needs only one selected connect, then remains enabled", () =>
  fixture(async (f) => {
    f.state.port = "5555"
    expect((await f.steps.enable.reconcile(f.context)).status).toBe("settled")
    const owner = f.intent(f.steps.enable, "setup")
    await f.steps.enable.execute(f.context, owner)
    expect(f.writes).toEqual([["connect", f.inputs.fixture.wifiEndpoint]])
    expect((await f.steps.restore.reconcile(f.context)).status).toBe("satisfied")
  }))

test("USB restoration does not depend on the earlier DHCP address", () =>
  fixture(async (f) => {
    await f.steps.enable.reconcile(f.context)
    const enabled = f.intent(f.steps.enable, "setup")
    await f.steps.enable.execute(f.context, enabled)
    f.state.boot = randomUUID()
    f.state.ip = "192.168.10.99"
    expect((await f.steps.restore.reconcile(f.context)).status).toBe("settled")
    const restore = f.intent(f.steps.restore, "teardown")
    await f.steps.restore.execute(f.context, restore)
    expect((await f.steps.restore.reconcile(f.context, restore)).status).toBe("satisfied")
    expect(f.state.port).toBe("-1")
    expect(f.writes.filter((a) => a[0] === "connect")).toEqual([["connect", f.inputs.fixture.wifiEndpoint]])
  }))

test("configuration exit error may reconcile from real current state, never resend", () =>
  fixture(async (f) => {
    await f.steps.enable.reconcile(f.context)
    f.state.throwAfterBroadcast = true
    const owner = f.intent(f.steps.enable, "setup")
    await f.steps.enable.execute(f.context, owner)
    await expect(f.steps.enable.execute(f.context, owner)).rejects.toThrow()
    const recovered = createWifiAdbSteps(f.inputs, f.safety, f.runtime)
    expect((await recovered.enable.reconcile(f.context, owner)).status).toBe("satisfied")
    expect(f.writes.length).toBe(2)
  }))

test("identity failure after original dispatch stays unknown and never connects/repeats", () =>
  fixture(async (f) => {
    await f.steps.enable.reconcile(f.context)
    f.state.dropAfterBroadcast = true
    const owner = f.intent(f.steps.enable, "setup")
    await expect(f.steps.enable.execute(f.context, owner)).rejects.toThrow("IDENTITY")
    expect((await f.steps.enable.reconcile(f.context, owner)).status).toBe("unknown")
    expect(f.writes.length).toBe(1)
  }))

test("active writer prevents enable", () =>
  fixture(async (f) => {
    f.state.safe = false
    expect((await f.steps.enable.reconcile(f.context)).status).toBe("unknown")
    const owner = f.intent(f.steps.enable, "setup")
    await expect(f.steps.enable.execute(f.context, owner)).rejects.toThrow("Active writer")
    expect(f.writes.length).toBe(0)
  }))

test("active writer prevents restoration without losing the original setting", () =>
  fixture(async (f) => {
    await f.steps.enable.reconcile(f.context)
    const enabled = f.intent(f.steps.enable, "setup")
    await f.steps.enable.execute(f.context, enabled)
    f.state.safe = false
    expect((await f.steps.restore.reconcile(f.context)).status).toBe("unknown")
    const restore = f.intent(f.steps.restore, "teardown")
    await expect(f.steps.restore.execute(f.context, restore)).rejects.toThrow("Active writer")
    expect(f.writes.length).toBe(2)
    expect(f.state.port).toBe("5555")
  }))

test("a new owner cannot adopt a previous dispatched preference change", () =>
  fixture(async (f) => {
    await f.steps.enable.reconcile(f.context)
    const owner = f.intent(f.steps.enable, "setup")
    await f.steps.enable.execute(f.context, owner)
    const replaced = {...owner, operationID: randomUUID()}
    const changed = {...f.context, operations: [replaced]}
    expect((await f.steps.enable.reconcile(changed, replaced)).status).toBe("unknown")
    await expect(f.steps.enable.execute(changed, replaced)).rejects.toThrow()
    expect(f.writes.length).toBe(2)
  }))

test("wrong IP or missing full MAC is rejected before any command write", () =>
  fixture(async (f) => {
    f.state.ip = "192.168.10.99"
    expect((await f.steps.enable.reconcile(f.context)).status).toBe("unknown")
    f.state.ip = "192.168.10.20"
    f.state.mac = ""
    expect((await f.steps.enable.reconcile(f.context)).status).toBe("unknown")
    expect(f.writes.length).toBe(0)
  }))

test("missing original observation with existing setup intent is not a successful restoration", () =>
  fixture(async (f) => {
    f.intent(f.steps.enable, "setup")
    expect((await f.steps.restore.reconcile(f.context)).status).toBe("unknown")
    expect(f.writes.length).toBe(0)
  }))

test("lost lease rejects before adb invocation and changed pinned inputs reject recovery", () =>
  fixture(async (f) => {
    await writeFile(f.inputs.leasePath, JSON.stringify({pid: process.pid + 1, token: "unowned"}), {mode: 0o600})
    expect((await f.steps.enable.reconcile(f.context)).status).toBe("unknown")
    expect(f.calls.length).toBe(0)
    await writeFile(f.inputs.leasePath, JSON.stringify({pid: process.pid, token: "owned"}), {mode: 0o600})
    await f.steps.enable.reconcile(f.context)
    const changed = createWifiAdbSteps(
      {...f.inputs, fixture: {...f.inputs.fixture, wifiEndpoint: "192.168.10.21:5555"}},
      f.safety,
      f.runtime,
    )
    expect((await changed.enable.reconcile(f.context)).status).toBe("unknown")
  }))
