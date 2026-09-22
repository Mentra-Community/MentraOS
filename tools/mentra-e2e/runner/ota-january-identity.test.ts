import {afterEach, expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {chmod, mkdir, mkdtemp, rm, symlink, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {dirname, join} from "node:path"
import {createJanuaryHardwareReader, loadJanuaryIdentityBinding} from "./ota-january-identity"
import {observeOtaHardware} from "./ota-hardware"
import {OtaHardwareUnavailable} from "./ota-state"
import type {LoadedOtaLegacyRoute, OtaRecordingFixture} from "./ota-recording"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, {recursive: true, force: true})))
})
const boot = "00000000-1111-2222-3333-444444444444"
const owner = "77777777-1111-2222-3333-444444444444"
const sourceBoot = "11111111-1111-2222-3333-444444444444"
const factorySha = "3f41ae1b05ad21c83b997719257a73944a34af916686d9a1e5440cb57b0cdbce"
const profileSha = "7f17e63f0ed5bd66f6a9e11940b82f6eeb8209fa88b558821ced0bef063123f6"
const fixture: OtaRecordingFixture = {
  serial: "TEST012345",
  wifiEndpoint: "192.0.2.10:5555",
  cid: "0123456789abcdef0123456789abcdef",
  bluetooth: "AA:BB:CC:DD:EE:01",
  before: {firmware: "20260113", asgVersion: 27, bootId: boot, slot: "_b"},
}
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
async function setup(change?: (name: string, value: any) => void) {
  const root = await mkdtemp(join(tmpdir(), "january-normal-bridge-"))
  dirs.push(root)
  const runDirectory = join(root, "stage")
  const objects: Record<string, any> = {}
  const save = async (name: string, value: any) => {
    change?.(name, value)
    objects[name] = structuredClone(value)
    const bytes = JSON.stringify(value)
    const path = join(root, name)
    await mkdir(dirname(path), {recursive: true})
    await writeFile(path, bytes, {mode: 0o600})
    return {path, sha256: sha(bytes), size: Buffer.byteLength(bytes)}
  }
  const cfg = {
    schemaVersion: 1,
    profileId: "january-20260113-powerwash-asg27",
    profileSha256: profileSha,
    fixture: {cid: fixture.cid, serial: fixture.serial, bootSerial: fixture.serial, mac: fixture.bluetooth},
    ota: {sha256: "a9ab45592ad0437f16aa286f9c9f4bdd8ffcb7b07818827a2966bc202186886d"},
    credential: {sha256: "b".repeat(64)},
  }
  const config = await save("config.json", cfg)
  const operation = await save("stage/operation.json", {
    run: runDirectory,
    owner,
    configSha256: config.sha256,
    profileSha256: profileSha,
    otaSha256: cfg.ota.sha256,
    source: {boot: sourceBoot, slot: "_a"},
  })
  await save("stage/stage-result.json", {
    owner,
    operationSha256: operation.sha256,
    status: "staged-awaiting-explicit-activation",
    payloadApplied: true,
    activationCount: 0,
  })
  const intent = await save("stage/activation/activation-intent.json", {
    schemaVersion: 1,
    owner,
    operation: "activate-full-ota",
    fixture: {cid: fixture.cid, serial: fixture.serial, mac: fixture.bluetooth},
    source: {boot: sourceBoot, slot: "_a", mtk: "MentraLive_20260921.0"},
    target: {mtk: "MentraLive_20260113", slot: "_b", asgVersionCode: 27, asgSha256: factorySha},
    ota: {
      kind: "full",
      sha256: cfg.ota.sha256,
      payloadSha256: "40dc039f47678451b306d5743f3d4399881b1a9bd9759318dcbbc24fe78df5f7",
      powerwash: true,
    },
    createdAt: 1000,
    activationCount: 1,
    resendAllowed: false,
  })
  const activation = await save("stage/activation/activation-result.json", {
    schemaVersion: 1,
    owner,
    status: "activation-dispatched",
    intentSha256: intent.sha256,
    updateEngineStatus: "UPDATED_NEED_REBOOT",
    payloadApplied: true,
    targetSlot: "_b",
    sourceBoot,
    acceptedAt: 1001,
    dispatchExitCode: 0,
    activationCount: 1,
  })
  const receipt = await save("stage/activation/receipt.json", {
    schemaVersion: 1,
    profile: "january-wiped-asg27",
    owner,
    credentialFileSha256: cfg.credential.sha256,
    intent: {path: intent.path, sha256: intent.sha256},
    activation: {path: activation.path, sha256: activation.sha256},
  })
  await save("stage/activation/recovery/inputs.json", {
    owner,
    receiptSha256: receipt.sha256,
    activationReceiptPath: receipt.path,
    intentSha256: intent.sha256,
    activationSha256: activation.sha256,
  })
  const after: any = {
    boot,
    cid: fixture.cid,
    serial: fixture.serial,
    bootSerial: fixture.serial,
    mac: "",
    mtk: "MentraLive_20260113",
    slot: "_b",
    uid: 2000,
    profile: "january-wiped-asg27",
    asgVersionCode: 27,
    asgSha256: factorySha,
    factoryAsgIdentity: {sha256: factorySha, versionCode: 27},
    persistedMacEmpty: true,
    freshBleBridge: {mac: fixture.bluetooth, endpoint: fixture.wifiEndpoint, ssidMatches: true},
  }
  const recoveryAfter = await save("stage/activation/recovery/after.json", after)
  const recovery = await save("stage/activation/recovery/result.json", {
    status: "passed",
    profile: "january-wiped-asg27",
    owner,
    firmwareWrites: 0,
    propertyWrites: 0,
    requestCount: 1,
    resend: false,
    factoryJanuaryIdentityVerified: true,
    newBootVerified: true,
    freshBleBridgeVerified: true,
  })
  const activationResult = await save("stage/activation/result.json", {
    status: "january-setup-baseline-verified",
    owner,
    setupBaselineReady: true,
    payloadApplied: true,
    activationCount: 1,
    newBootVerified: true,
    recoveryResultSha256: recovery.sha256,
    powerwashRequested: true,
    customerRoutinePassed: false,
    fixtureReadyForOtherRoutines: false,
    finalModernFirmwareVerificationPassed: false,
    completedAt: 1005,
    besSetupContinuity: {newBoot: boot},
  })
  const baseline = {config, owner, activationResult, recoveryAfter}
  const artifacts = []
  const manifests = []
  const hashes: Record<number, string> = {27: factorySha}
  for (const version of [31, 37]) {
    const bytes = `offline test APK ${version}`
    const path = join(root, `${version}.apk`)
    await writeFile(path, bytes)
    const url = `https://example.test/${version}.apk`
    hashes[version] = sha(bytes)
    artifacts.push({path, url, sha256: sha(bytes), size: Buffer.byteLength(bytes)})
    manifests.push({
      ...(await save(`${version}.json`, {versionCode: version, sha256: sha(bytes), apkUrl: url})),
      url: `https://example.test/${version}.json`,
    })
  }
  const legacy = {
    route: {manifests, artifacts},
    allowedFirmware: ["MentraLive_20260113", "MentraLive_20260709"],
    allowedAsg: [27, 31, 37, 39],
  } as LoadedOtaLegacyRoute
  const calls: string[][] = []
  const values: Record<string, string> = {
    "getprop persist.mentra.live.mac": "",
    "cat /proc/sys/kernel/random/boot_id": boot,
    "cat /sys/block/mmcblk0/device/cid": fixture.cid,
    "getprop ro.serialno": fixture.serial,
    "getprop ro.boot.serialno": fixture.serial,
    "getprop ro.custom.ota.version": "20260113",
    "getprop sys.boot_completed": "1",
    "getprop ro.boot.slot_suffix": "_b",
    "dumpsys package com.mentra.asg_client": "versionCode=27",
    "pm path com.mentra.asg_client": "package:/data/app/test/base.apk",
    "sha256sum /data/app/test/base.apk": factorySha + " /data/app/test/base.apk",
  }
  const run = async (argv: string[]) => {
    calls.push(argv)
    if (argv.join(" ") === "adb devices -l") return fixture.wifiEndpoint + " device transport_id:7"
    if (argv[0] !== "adb" || argv[1] !== "-t" || argv[2] !== "7" || argv[3] !== "shell")
      throw Error("unexpected command")
    const key = argv.slice(4).join(" ")
    if (!(key in values)) throw Error("unexpected shell " + key)
    return values[key]
  }
  return {root, baseline, legacy, values, run, calls, hashes, after, objects}
}
async function read(env: Awaited<ReturnType<typeof setup>>) {
  const reader = await createJanuaryHardwareReader({baseline: env.baseline, fixture, legacy: env.legacy}, env.run)
  return reader.readHardware(fixture, env.legacy.allowedFirmware, env.legacy.allowedAsg, true)
}

test("same original boot preserves raw empty property and explicit immutable BLE provenance for27/31/37", async () => {
  const env = await setup()
  const reader = await createJanuaryHardwareReader({baseline: env.baseline, fixture, legacy: env.legacy}, env.run)
  expect(env.calls).toHaveLength(0)
  for (const version of [27, 31, 37]) {
    env.values["dumpsys package com.mentra.asg_client"] = `versionCode=${version}`
    env.values["sha256sum /data/app/test/base.apk"] = env.hashes[version] + " /data/app/test/base.apk"
    const actual: any = await reader.readHardware(fixture, env.legacy.allowedFirmware, env.legacy.allowedAsg, true)
    expect(actual.bluetooth).toBe(fixture.bluetooth)
    expect(actual.persistedBluetooth).toBe("")
    expect(actual.asgVersion).toBe(version)
    expect(actual.apkSha256).toBe(env.hashes[version])
    expect(actual.bluetoothProvenance).toMatchObject({
      activationResult: env.baseline.activationResult,
      recoveryAfter: env.baseline.recoveryAfter,
      endpoint: fixture.wifiEndpoint,
      persistedPropertyObservedEmpty: true,
    })
  }
  expect(env.calls.some((call) => call.includes("setprop") || call.includes("push") || call.includes("reboot"))).toBe(
    false,
  )
})

test("a real nonempty MAC delegates to strict normal observation; conflicting values are not substituted", async () => {
  const env = await setup()
  env.values["getprop persist.mentra.live.mac"] = fixture.bluetooth
  env.values["cat /proc/sys/kernel/random/boot_id"] = "new-normal-boot"
  env.values["getprop ro.custom.ota.version"] = "20260709"
  env.values["dumpsys package com.mentra.asg_client"] = "versionCode=39"
  const actual: any = await read(env)
  expect(actual.bootId).toBe("new-normal-boot")
  expect(actual.firmware).toBe("MentraLive_20260709")
  expect(actual.bluetoothProvenance).toBeUndefined()
  expect(env.calls.filter((call) => call.slice(4).join(" ") === "getprop persist.mentra.live.mac")).toHaveLength(2)
  env.values["getprop persist.mentra.live.mac"] = "11:22:33:44:55:66"
  await expect(read(env)).rejects.toThrow("HARDWARE_BLUETOOTH_MISMATCH")
})

test("new boot with empty MAC stays unavailable until real identity returns; physical mismatches remain terminal", async () => {
  const env = await setup()
  env.values["cat /proc/sys/kernel/random/boot_id"] = "new-normal-boot"
  await expect(read(env)).rejects.toBeInstanceOf(OtaHardwareUnavailable)
  const unavailable: string[] = []
  expect(
    await observeOtaHardware(
      () => read(env),
      async (error) => {
        unavailable.push(error.kind)
      },
    ),
  ).toBeUndefined()
  expect(unavailable).toEqual(["boot"])
  env.values["getprop ro.serialno"] = "OTHER"
  await expect(read(env)).rejects.toThrow("CURRENT_IDENTITY_MISMATCH")
  env.values["getprop ro.serialno"] = fixture.serial
  env.values["getprop persist.mentra.live.mac"] = fixture.bluetooth
  env.values["getprop ro.custom.ota.version"] = "20260709"
  env.values["dumpsys package com.mentra.asg_client"] = "versionCode=39"
  expect((await read(env)).bootId).toBe("new-normal-boot")
})

test("missing or mismatched current identity, firmware, ASG and exact APK stop the empty-property bridge", async () => {
  for (const [key, value, code] of [
    ["cat /sys/block/mmcblk0/device/cid", "f".repeat(32), "CURRENT_IDENTITY_MISMATCH"],
    ["getprop ro.serialno", "OTHER", "CURRENT_IDENTITY_MISMATCH"],
    ["getprop ro.boot.serialno", "OTHER", "CURRENT_IDENTITY_MISMATCH"],
    ["getprop ro.custom.ota.version", "20260709", "CURRENT_BOOT_NOT_JANUARY"],
    ["getprop ro.boot.slot_suffix", "_a", "CURRENT_BOOT_NOT_JANUARY"],
    ["getprop sys.boot_completed", "0", "CURRENT_BOOT_NOT_JANUARY"],
    ["dumpsys package com.mentra.asg_client", "versionCode=39", "ASG_NOT_SUPPORTED"],
    ["sha256sum /data/app/test/base.apk", "f".repeat(64), "ACTIVE_APK_HASH_MISMATCH"],
    ["pm path com.mentra.asg_client", "package:/one.apk\npackage:/two.apk", "ACTIVE_APK_PATH_AMBIGUOUS"],
  ]) {
    const env = await setup()
    env.values[key] = value
    await expect(read(env)).rejects.toThrow(code)
  }
})

test("closing boot/property/package changes fail once without any automatic command retry", async () => {
  for (const command of [
    "cat /proc/sys/kernel/random/boot_id",
    "getprop persist.mentra.live.mac",
    "pm path com.mentra.asg_client",
  ]) {
    const env = await setup()
    let reads = 0
    const reader = await createJanuaryHardwareReader(
      {baseline: env.baseline, fixture, legacy: env.legacy},
      async (argv) => {
        const value = await env.run(argv)
        if (argv.slice(4).join(" ") === command && ++reads === 2)
          return command.startsWith("pm") ? "package:/changed.apk" : "changed"
        return value
      },
    )
    await expect(
      reader.readHardware(fixture, env.legacy.allowedFirmware, env.legacy.allowedAsg, true),
    ).rejects.toThrow()
    expect(reads).toBe(2)
  }
})

test("normal canonical activation/config/owner/receipt and exact recovered identity must all agree", async () => {
  for (const [file, alter] of [
    [
      "config.json",
      (v: any) => {
        v.profileSha256 = "f".repeat(64)
      },
    ],
    [
      "stage/operation.json",
      (v: any) => {
        v.configSha256 = "f".repeat(64)
      },
    ],
    [
      "stage/stage-result.json",
      (v: any) => {
        v.owner = sourceBoot
      },
    ],
    [
      "stage/activation/result.json",
      (v: any) => {
        v.status = "failed"
      },
    ],
    [
      "stage/activation/result.json",
      (v: any) => {
        v.reconciledFrom = "asg_not_factory_path"
      },
    ],
    [
      "stage/activation/receipt.json",
      (v: any) => {
        v.owner = sourceBoot
      },
    ],
    [
      "stage/activation/activation-intent.json",
      (v: any) => {
        v.fixture.cid = "f".repeat(32)
      },
    ],
    [
      "stage/activation/activation-result.json",
      (v: any) => {
        v.activationCount = 2
      },
    ],
    [
      "stage/activation/recovery/inputs.json",
      (v: any) => {
        v.receiptSha256 = "e".repeat(64)
      },
    ],
    [
      "stage/activation/recovery/result.json",
      (v: any) => {
        v.propertyWrites = 1
      },
    ],
    [
      "stage/activation/recovery/after.json",
      (v: any) => {
        v.freshBleBridge.mac = "11:22:33:44:55:66"
      },
    ],
    [
      "stage/activation/recovery/after.json",
      (v: any) => {
        v.freshBleBridge.endpoint = "192.0.2.11:5555"
      },
    ],
    [
      "stage/activation/recovery/after.json",
      (v: any) => {
        v.boot = sourceBoot
      },
    ],
    [
      "stage/activation/recovery/after.json",
      (v: any) => {
        v.factoryAsgIdentity.sha256 = "f".repeat(64)
      },
    ],
  ] as const) {
    const env = await setup((name, value) => {
      if (name === file) alter(value)
    })
    await expect(read(env)).rejects.toThrow("JANUARY_BRIDGE_")
    expect(env.calls).toHaveLength(0)
  }
})

test("frozen evidence cannot be replaced, unpinned, made public, or adopted from a failed run", async () => {
  for (const change of [
    async (e: Awaited<ReturnType<typeof setup>>) => {
      await writeFile(e.baseline.recoveryAfter.path, "{}")
    },
    async (e: Awaited<ReturnType<typeof setup>>) => {
      delete (e.baseline.config as any).sha256
    },
    async (e: Awaited<ReturnType<typeof setup>>) => {
      e.baseline.owner = sourceBoot
    },
    async (e: Awaited<ReturnType<typeof setup>>) => {
      await chmod(e.baseline.config.path, 0o644)
    },
    async (e: Awaited<ReturnType<typeof setup>>) => {
      await writeFile(join(e.root, "stage/activation/failure.json"), "{}")
    },
    async (e: Awaited<ReturnType<typeof setup>>) => {
      const target = join(e.root, "symlink.json")
      await symlink(e.baseline.config.path, target)
      e.baseline.config.path = target
    },
  ]) {
    const env = await setup()
    await change(env)
    await expect(read(env)).rejects.toThrow()
    expect(env.calls).toHaveLength(0)
  }
})

test("loading only binds prior setup identity; it makes no live read or final readiness claim", async () => {
  const env = await setup()
  const binding = await loadJanuaryIdentityBinding(env.baseline, fixture)
  expect(binding.originalBoot).toBe(boot)
  expect(binding.evidence).toEqual(env.baseline)
  expect("fixtureReady" in binding).toBe(false)
  expect(env.calls).toHaveLength(0)
  env.legacy.route.artifacts[0].sha256 = "f".repeat(64)
  await expect(read(env)).rejects.toThrow("LEGACY_APK_NOT_IN_FROZEN_ROUTE")
})

test("synthetic normal activation receipts satisfy the canonical Python ownership validator", async () => {
  const env = await setup()
  const process = Bun.spawn(
    [
      "python3",
      "-c",
      `import json,sys
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,sys.argv[1])
import config,recover_wiped
value=json.loads(Path(sys.argv[2]).read_text())
assert value['profileSha256']==config.PROFILE_SHA
cfg=SimpleNamespace(fixture={k:value['fixture'][k] for k in ('cid','serial','mac')})
proof=recover_wiped.activation_proof(cfg,Path(sys.argv[3]),value['credential']['sha256'])
print(json.dumps(proof))
`,
      join(import.meta.dir, "../adapters/day1-setup"),
      env.baseline.config.path,
      join(env.root, "stage/activation/receipt.json"),
    ],
    {stdout: "pipe", stderr: "pipe"},
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  expect(stderr).toBe("")
  expect(code).toBe(0)
  expect(JSON.parse(stdout).owner).toBe(owner)
  expect(env.calls).toHaveLength(0)
})
