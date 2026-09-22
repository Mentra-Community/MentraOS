import {expect, test} from "bun:test"
import {observeOtaHardware, OtaCommandError, readOtaHardware} from "./ota-hardware"
import {OtaHardwareUnavailable, OtaValidationError, selectUsbTransport, selectWifiTransport} from "./ota-state"

const fixture = {serial: "fixture-serial", usb: "fixture-port", cid: "aabb", bluetooth: "AA:BB:CC:DD:EE:FF"}
const inventory = `List of devices attached\n${fixture.serial} device usb:${fixture.usb} transport_id:9\n`
const target = "MentraLive_20260915.0"

function commands(overrides: Record<string, string | Error> = {}) {
  const output: Record<string, string | Error> = {
    "devices -l": inventory,
    "cat /sys/block/mmcblk0/device/cid": fixture.cid,
    "getprop ro.serialno": fixture.serial,
    "getprop persist.mentra.live.mac": fixture.bluetooth,
    "getprop ro.custom.ota.version": target,
    "getprop sys.boot_completed": "1",
    "cat /proc/sys/kernel/random/boot_id": "fixture-boot",
    "getprop ro.boot.slot_suffix": "_a",
    "dumpsys package com.mentra.asg_client": "versionCode=200",
    ...overrides,
  }
  return async (args: string[]) => {
    const key = args[1] === "devices" ? args.slice(1).join(" ") : args.slice(4).join(" ")
    const result = output[key]
    if (result === undefined) throw new Error(`Unexpected test command: ${key}`)
    if (result instanceof Error) throw result
    return result
  }
}

function read(run = commands()) {
  return readOtaHardware(fixture, [target], [200], true, run)
}

test("a nonempty invalid firmware observation is terminal even if the next poll would match the target", async () => {
  for (const firmware of ["invalid-version", "20260915.bad", "MentraLive_20260101"]) {
    let polls = 0
    const accepted: string[] = []
    const downtime: string[] = []
    const poll = async () => {
      for (let i = 0; i < 2; i++) {
        const result = await observeOtaHardware(
          () => read(commands({"getprop ro.custom.ota.version": polls++ === 0 ? firmware : target})),
          async (error) => {
            downtime.push(error.kind)
          },
        )
        if (result) accepted.push(result.firmware)
      }
    }
    await expect(poll()).rejects.toBeInstanceOf(OtaValidationError)
    expect(polls).toBe(1)
    expect(accepted).toEqual([])
    expect(downtime).toEqual([])
  }
})

test("invalid firmware cannot be hidden by boot state or a later transport failure", async () => {
  for (const boot of ["0", new OtaCommandError("transport dropped after firmware read")]) {
    await expect(
      read(
        commands({
          "getprop ro.custom.ota.version": "invalid-version",
          "getprop sys.boot_completed": boot,
        }),
      ),
    ).rejects.toBeInstanceOf(OtaValidationError)
  }
})

test("an empty firmware property is boot downtime only before boot completes", async () => {
  const downtime: string[] = []
  const result = await observeOtaHardware(
    () => read(commands({"getprop ro.custom.ota.version": "", "getprop sys.boot_completed": "0"})),
    async (error) => {
      downtime.push(error.kind)
    },
  )
  expect(result).toBeUndefined()
  expect(downtime).toEqual(["boot"])
  expect((await read()).firmware).toBe(target)
  await expect(read(commands({"getprop ro.custom.ota.version": ""}))).rejects.toBeInstanceOf(OtaValidationError)
})

test("temporarily missing ASG is classified as boot downtime", async () => {
  await expect(
    read(
      commands({
        "dumpsys package com.mentra.asg_client": "",
        "getprop sys.boot_completed": "0",
      }),
    ),
  ).rejects.toBeInstanceOf(OtaHardwareUnavailable)
})

test("only a fresh disconnected or changed transport classifies a failed shell command as reconnect downtime", async () => {
  const failure = new OtaCommandError("read failed")
  for (const nextInventory of [
    "List of devices attached\n",
    inventory.replace(" device ", " offline "),
    inventory.replace("transport_id:9", "transport_id:10"),
  ]) {
    let inventories = 0
    const run = commands({"cat /sys/block/mmcblk0/device/cid": failure})
    const state = await observeOtaHardware(
      () =>
        read(async (args) => {
          if (args[1] === "devices") return inventories++ === 0 ? inventory : nextInventory
          return run(args)
        }),
      async (error) => {
        expect(error.kind).toBe("transport")
      },
    )
    expect(state).toBeUndefined()
    expect(inventories).toBe(2)
  }
  await expect(read(commands({"cat /sys/block/mmcblk0/device/cid": failure}))).rejects.toBe(failure)
})

test("USB authorization, identity and evidence errors are terminal", async () => {
  for (const bad of [
    inventory.replace(" device ", " unauthorized "),
    inventory.replace(fixture.usb, "other-port"),
    inventory + inventory,
    inventory.replace(" transport_id:9", ""),
  ])
    expect(() => selectUsbTransport(bad, fixture.serial, fixture.usb)).toThrow(OtaValidationError)
  const identityMismatches: Record<string, string>[] = [
    {"cat /sys/block/mmcblk0/device/cid": "different-cid"},
    {"getprop ro.serialno": "different-serial"},
    {"getprop persist.mentra.live.mac": "different-bluetooth"},
  ]
  for (const override of identityMismatches)
    await expect(read(commands(override))).rejects.toBeInstanceOf(OtaValidationError)
  const evidenceFailure = new Error("Evidence write failed")
  await expect(
    observeOtaHardware(
      async () => {
        throw evidenceFailure
      },
      async () => {
        throw new Error("Must not record evidence failure as downtime")
      },
    ),
  ).rejects.toBe(evidenceFailure)
  const inventoryFailure = new OtaCommandError("ADB inventory unavailable")
  await expect(read(commands({"devices -l": inventoryFailure}))).rejects.toBe(inventoryFailure)
})

const wifiFixture = {...fixture, usb: undefined, wifiEndpoint: "192.168.1.186:5555"}
const wifiInventory = `${wifiFixture.wifiEndpoint} device transport_id:12\n`

test("Wi-Fi observation verifies the same hardware identity and targets only the selected transport", async () => {
  const calls: string[][] = []
  const run = commands({"devices -l": inventory + wifiInventory})
  const result = await readOtaHardware(wifiFixture, [target], [200], false, async (args) => {
    calls.push(args)
    return run(args)
  })
  expect(result.transport).toBe("12")
  expect(calls.filter((args) => args[1] !== "devices").every((args) => args[1] === "-t" && args[2] === "12")).toBe(true)
  for (const mismatch of [
    {"cat /sys/block/mmcblk0/device/cid": "other-cid"},
    {"getprop ro.serialno": "other-serial"},
    {"getprop persist.mentra.live.mac": "AA:00:00:00:00:00"},
  ])
    await expect(
      readOtaHardware(wifiFixture, [target], [200], false, commands({"devices -l": wifiInventory, ...mismatch})),
    ).rejects.toBeInstanceOf(OtaValidationError)
  // A USB match never substitutes for the explicitly selected endpoint.
  await expect(readOtaHardware(wifiFixture, [target], [200], false, commands())).rejects.toBeInstanceOf(
    OtaHardwareUnavailable,
  )
})

test("Wi-Fi reconnect is observable downtime, but authentication and ambiguous selectors stay terminal", async () => {
  const failure = new OtaCommandError("Wi-Fi disconnected")
  for (const nextInventory of ["", wifiInventory.replace("device", "offline"), wifiInventory.replace(":12", ":13")]) {
    let reads = 0
    const run = commands({"cat /sys/block/mmcblk0/device/cid": failure})
    await expect(
      readOtaHardware(wifiFixture, [target], [200], true, async (args) =>
        args[1] === "devices" ? (reads++ === 0 ? wifiInventory : nextInventory) : run(args),
      ),
    ).rejects.toBeInstanceOf(OtaHardwareUnavailable)
  }
  for (const bad of [
    wifiInventory + wifiInventory,
    wifiInventory.replace("device", "unauthorized"),
    wifiInventory.replace("transport_id:12", ""),
    wifiInventory.replace("transport_id:12", "usb:other transport_id:12"),
  ])
    expect(() => selectWifiTransport(bad, wifiFixture.wifiEndpoint)).toThrow(OtaValidationError)
  for (const endpoint of ["192.168.1.186", "300.1.2.3:5555", "host:5555", "192.168.1.186:0", "192.168.1.186:65536"])
    expect(() => selectWifiTransport(wifiInventory, endpoint)).toThrow(OtaValidationError)
  for (const selection of [
    {...fixture, wifiEndpoint: wifiFixture.wifiEndpoint},
    {...fixture, usb: undefined},
  ])
    await expect(readOtaHardware(selection, [target], [200], false, commands())).rejects.toBeInstanceOf(
      OtaValidationError,
    )
  await expect(
    readOtaHardware(
      wifiFixture,
      [target],
      [200],
      true,
      commands({
        "devices -l": wifiInventory,
        "cat /sys/block/mmcblk0/device/cid": failure,
      }),
    ),
  ).rejects.toBe(failure)
})
