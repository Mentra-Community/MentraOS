/** Original-January-boot identity continuity under the caller-owned lease.
 * Loading verifies local normal-activation evidence; the returned callback only
 * reads ADB. It never writes or substitutes a device property. */
import {createHash} from "node:crypto"
import {constants} from "node:fs"
import {access, open} from "node:fs/promises"
import {basename, dirname, isAbsolute, join, normalize} from "node:path"
import {otaCommand, OtaCommandError, readOtaHardware, type OtaFixture} from "./ota-hardware"
import {verifyFrozenFile} from "./ota-legacy-route"
import type {LoadedOtaLegacyRoute, OtaRecordingFixture} from "./ota-recording"
import {
  checkOtaObservedVersions,
  normalizeFirmware,
  OtaHardwareUnavailable,
  OtaValidationError,
  selectUsbTransport,
  selectWifiTransport,
} from "./ota-state"

export type JsonReference = {path: string; sha256: string}
const JANUARY = "MentraLive_20260113"
const HASH = /^[a-f0-9]{64}$/
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
function requireProof(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new OtaValidationError(`JANUARY_BRIDGE_${reason}`)
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
// These identify the existing fixed Python setup profile, not a new selector.
const PROFILE_SHA = "7f17e63f0ed5bd66f6a9e11940b82f6eeb8209fa88b558821ced0bef063123f6"
const FACTORY_ASG_SHA = "3f41ae1b05ad21c83b997719257a73944a34af916686d9a1e5440cb57b0cdbce"

export interface JanuarySetupEvidence {
  config: JsonReference
  owner: string
  activationResult: JsonReference
  recoveryAfter: JsonReference
}

async function jsonFile(path: string, expectedSha?: string, privateFile = false) {
  requireProof(typeof path === "string" && isAbsolute(path) && normalize(path) === path, "INVALID_RECEIPT_REFERENCE")
  requireProof(expectedSha === undefined || HASH.test(expectedSha), "INVALID_RECEIPT_REFERENCE")
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    requireProof(stat.isFile() && stat.size > 0 && stat.size <= 2 * 1024 * 1024, "INVALID_RECEIPT_FILE")
    requireProof(
      !privateFile || (stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid?.()),
      "RECEIPT_NOT_PRIVATE",
    )
    const bytes = await file.readFile()
    requireProof(bytes.length <= 2 * 1024 * 1024, "INVALID_RECEIPT_FILE")
    const sha256 = digest(bytes)
    requireProof(expectedSha === undefined || sha256 === expectedSha, "RECEIPT_HASH_CHANGED")
    const value = JSON.parse(bytes.toString("utf8"))
    requireProof(value && typeof value === "object" && !Array.isArray(value), "INVALID_RECEIPT_JSON")
    return {value, reference: {path, sha256}}
  } finally {
    await file.close()
  }
}
async function frozenJson(ref: JsonReference) {
  requireProof(ref && HASH.test(ref.sha256), "INVALID_RECEIPT_REFERENCE")
  return (await jsonFile(ref.path, ref.sha256)).value
}
async function absent(path: string) {
  try {
    await access(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  throw new OtaValidationError("JANUARY_BRIDGE_FAILED_SETUP_REQUIRES_SEPARATE_REVIEW")
}

/** The trusted routine freezes these references after the normal Python setup
 * and its canonical reconciliation succeed. This binds identity to that output;
 * it does not reimplement setup, claim readiness, or accept historical recovery
 * overrides. Recovery-after has its own explicit pin because the normal result
 * does not hash that file. No arbitrary age limit is added to a same-boot binding. */
export async function loadJanuaryIdentityBinding(selected: JanuarySetupEvidence, selectedFixture: OtaRecordingFixture) {
  const evidence = structuredClone(selected)
  const fixture = structuredClone(selectedFixture)
  requireProof(UUID.test(evidence.owner), "INVALID_OWNER")
  requireProof(
    [evidence.config, evidence.activationResult, evidence.recoveryAfter].every(
      (ref) => ref && typeof ref.path === "string" && HASH.test(ref.sha256),
    ),
    "INVALID_RECEIPT_REFERENCE",
  )
  const cfg = (await jsonFile(evidence.config.path, evidence.config.sha256, true)).value
  const folder = dirname(evidence.activationResult.path)
  const run = dirname(folder)
  requireProof(
    basename(folder) === "activation" &&
      basename(evidence.activationResult.path) === "result.json" &&
      evidence.recoveryAfter.path === join(folder, "recovery", "after.json"),
    "NONCANONICAL_RESULT_PATH",
  )
  await absent(join(run, "failure.json"))
  await absent(join(folder, "failure.json"))
  await absent(join(folder, "recovery", "failure.json"))
  const local = async (relative: string, hash?: string) => jsonFile(join(run, relative), hash, true)
  const {value: operation, reference: operationRef} = await local("operation.json")
  const {value: stage} = await local("stage-result.json")
  const {value: result} = await jsonFile(evidence.activationResult.path, evidence.activationResult.sha256, true)
  requireProof(
    cfg.schemaVersion === 1 &&
      cfg.profileId === "january-20260113-powerwash-asg27" &&
      cfg.profileSha256 === PROFILE_SHA &&
      operation.run === run &&
      operation.owner === evidence.owner &&
      operation.configSha256 === evidence.config.sha256 &&
      operation.profileSha256 === PROFILE_SHA &&
      operation.otaSha256 === cfg.ota?.sha256 &&
      HASH.test(operation.otaSha256) &&
      stage.owner === evidence.owner &&
      stage.operationSha256 === operationRef.sha256 &&
      stage.status === "staged-awaiting-explicit-activation" &&
      stage.payloadApplied === true &&
      stage.activationCount === 0,
    "SETUP_NOT_BOUND_TO_CONFIG",
  )
  requireProof(
    result.status === "january-setup-baseline-verified" &&
      result.owner === evidence.owner &&
      result.payloadApplied === true &&
      result.activationCount === 1 &&
      result.newBootVerified === true &&
      result.setupBaselineReady === true &&
      result.customerRoutinePassed === false &&
      result.fixtureReadyForOtherRoutines === false &&
      result.finalModernFirmwareVerificationPassed === false &&
      result.powerwashRequested === true &&
      !("reconciledFrom" in result),
    "NORMAL_ACTIVATION_NOT_COMPLETE",
  )
  const {value: receipt, reference: receiptRef} = await local("activation/receipt.json")
  requireProof(
    receipt.schemaVersion === 1 &&
      receipt.profile === "january-wiped-asg27" &&
      receipt.owner === evidence.owner &&
      receipt.credentialFileSha256 === cfg.credential?.sha256 &&
      receipt.intent?.path === join(folder, "activation-intent.json") &&
      HASH.test(receipt.intent.sha256) &&
      receipt.activation?.path === join(folder, "activation-result.json") &&
      HASH.test(receipt.activation.sha256),
    "ACTIVATION_RECEIPT_MISMATCH",
  )
  const {value: intent} = await local("activation/activation-intent.json", receipt.intent.sha256)
  const {value: accepted} = await local("activation/activation-result.json", receipt.activation.sha256)
  requireProof(
    intent.owner === evidence.owner &&
      intent.operation === "activate-full-ota" &&
      intent.activationCount === 1 &&
      intent.resendAllowed === false &&
      intent.source?.boot === operation.source?.boot &&
      intent.source?.slot === operation.source?.slot &&
      UUID.test(intent.source.boot) &&
      ["_a", "_b"].includes(intent.source.slot) &&
      intent.target?.mtk === JANUARY &&
      intent.target.asgVersionCode === 27 &&
      intent.target.asgSha256 === FACTORY_ASG_SHA &&
      intent.target.slot === (intent.source.slot === "_a" ? "_b" : "_a") &&
      intent.ota?.sha256 === operation.otaSha256 &&
      intent.ota.powerwash === true &&
      intent.fixture?.cid === cfg.fixture?.cid &&
      intent.fixture?.serial === cfg.fixture?.serial &&
      intent.fixture?.mac === cfg.fixture?.mac &&
      accepted.owner === evidence.owner &&
      accepted.status === "activation-dispatched" &&
      accepted.intentSha256 === receipt.intent.sha256 &&
      accepted.payloadApplied === true &&
      accepted.activationCount === 1 &&
      accepted.dispatchExitCode === 0 &&
      accepted.sourceBoot === intent.source.boot &&
      accepted.targetSlot === intent.target.slot &&
      Number.isFinite(intent.createdAt) &&
      intent.createdAt > 0 &&
      Number.isFinite(accepted.acceptedAt) &&
      intent.createdAt <= accepted.acceptedAt &&
      Number.isFinite(result.completedAt) &&
      accepted.acceptedAt <= result.completedAt,
    "ACTIVATION_NOT_OWNED",
  )
  requireProof(HASH.test(result.recoveryResultSha256), "RECOVERY_NOT_BOUND")
  const {value: recovered} = await local("activation/recovery/result.json", result.recoveryResultSha256)
  const {value: inputs} = await local("activation/recovery/inputs.json")
  requireProof(
    recovered.status === "passed" &&
      recovered.owner === evidence.owner &&
      recovered.profile === receipt.profile &&
      recovered.firmwareWrites === 0 &&
      recovered.propertyWrites === 0 &&
      recovered.resend === false &&
      [0, 1].includes(recovered.requestCount) &&
      recovered.factoryJanuaryIdentityVerified === true &&
      recovered.newBootVerified === true &&
      recovered.freshBleBridgeVerified === true &&
      inputs.owner === evidence.owner &&
      inputs.receiptSha256 === receiptRef.sha256 &&
      inputs.activationReceiptPath === receiptRef.path &&
      inputs.intentSha256 === receipt.intent.sha256 &&
      inputs.activationSha256 === receipt.activation.sha256,
    "RECOVERY_NOT_COMPLETE",
  )
  const {value: after} = await jsonFile(evidence.recoveryAfter.path, evidence.recoveryAfter.sha256, true)
  const bridge = after.freshBleBridge
  requireProof(
    !fixture.usb &&
      fixture.wifiEndpoint &&
      /^\d{1,3}(?:\.\d{1,3}){3}:5555$/.test(fixture.wifiEndpoint) &&
      fixture.serial !== "0123456789ABCDEF" &&
      /^[a-f0-9]{32}$/i.test(fixture.cid) &&
      /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(fixture.bluetooth),
    "FIXTURE_MUST_MATCH_VERIFIED_WIFI",
  )
  requireProof(
    cfg.fixture?.cid === fixture.cid.toLowerCase() &&
      cfg.fixture?.serial === fixture.serial &&
      cfg.fixture?.mac === fixture.bluetooth.toUpperCase() &&
      bridge?.mac === cfg.fixture.mac &&
      bridge.endpoint === fixture.wifiEndpoint &&
      bridge.ssidMatches === true &&
      after.cid === cfg.fixture.cid &&
      after.serial === fixture.serial &&
      typeof cfg.fixture.bootSerial === "string" &&
      /^[A-Za-z0-9_-]{1,64}$/.test(cfg.fixture.bootSerial) &&
      after.bootSerial === cfg.fixture.bootSerial &&
      UUID.test(after.boot) &&
      after.boot !== intent.source.boot &&
      after.boot === fixture.before.bootId &&
      after.slot === intent.target.slot &&
      after.slot === fixture.before.slot &&
      normalizeFirmware(after.mtk) === JANUARY &&
      normalizeFirmware(fixture.before.firmware) === JANUARY &&
      after.asgVersionCode === 27 &&
      fixture.before.asgVersion === 27 &&
      after.mac === "" &&
      after.persistedMacEmpty === true &&
      after.uid === 2000 &&
      after.profile === receipt.profile &&
      after.asgSha256 === FACTORY_ASG_SHA &&
      after.factoryAsgIdentity?.sha256 === FACTORY_ASG_SHA &&
      after.factoryAsgIdentity?.versionCode === 27 &&
      result.besSetupContinuity?.newBoot === after.boot,
    "BASELINE_IDENTITY_MISMATCH",
  )
  return {
    evidence,
    fixture,
    originalBoot: after.boot as string,
    bootSerial: after.bootSerial as string,
    slot: after.slot as string,
    factoryAsgSha256: FACTORY_ASG_SHA,
    bridge: {mac: bridge.mac as string, endpoint: bridge.endpoint as string},
  }
}

export async function createJanuaryHardwareReader(
  input: {
    baseline: JanuarySetupEvidence
    fixture: OtaRecordingFixture
    legacy: LoadedOtaLegacyRoute
    /** Optional cable selected before the run. Never enable or reconnect ADB here. */
    returnUsb?: string
  },
  command: typeof otaCommand = otaCommand,
) {
  const {baseline, fixture, legacy, returnUsb} = structuredClone(input)
  requireProof(returnUsb === undefined || /^[A-Za-z0-9.-]{1,80}$/.test(returnUsb), "INVALID_RETURN_USB_PATH")
  const binding = await loadJanuaryIdentityBinding(baseline, fixture)
  const {bridge} = binding
  requireProof(
    legacy.allowedFirmware.includes(JANUARY) && legacy.allowedAsg.includes(27),
    "JANUARY_NOT_IN_SELECTED_ROUTE",
  )
  const hashes = new Map<number, string>([[27, binding.factoryAsgSha256]])
  for (const reference of legacy.route.manifests) {
    const manifest = await frozenJson(reference)
    const app = manifest.apps?.["com.mentra.asg_client"] ?? manifest
    if (![31, 37].includes(app.versionCode)) continue
    requireProof(!hashes.has(app.versionCode) && HASH.test(app.sha256), "AMBIGUOUS_LEGACY_ASG")
    const matches = legacy.route.artifacts.filter(
      (artifact) => artifact.url === app.apkUrl && artifact.sha256 === app.sha256,
    )
    requireProof(matches.length === 1 && legacy.allowedAsg.includes(app.versionCode), "LEGACY_APK_NOT_IN_FROZEN_ROUTE")
    await verifyFrozenFile(matches[0])
    hashes.set(app.versionCode, app.sha256)
  }
  requireProof(hashes.has(31) && hashes.has(37), "INCOMPLETE_LEGACY_ASG_ROUTE")
  const fixtureKey = (value: OtaFixture) =>
    JSON.stringify([
      value.serial,
      value.usb ?? null,
      value.wifiEndpoint ?? null,
      value.cid.toLowerCase(),
      value.bluetooth.toUpperCase(),
    ])
  const assertOriginalBoot = (boot: string) => requireProof(boot === binding.originalBoot, "ORIGINAL_BOOT_CHANGED")

  const readHardware: typeof readOtaHardware = async (selected, allowedFirmware, asgVersions, observingActivePass) => {
    requireProof(fixtureKey(selected) === fixtureKey(fixture), "SELECTED_FIXTURE_CHANGED")
    const startedAt = new Date().toISOString()
    const inventory = () => command(["adb", "devices", "-l"])
    let transport: string
    try {
      transport = selectWifiTransport(await inventory(), fixture.wifiEndpoint!)
    } catch (error) {
      // Normal customer firmware can disable Wi-Fi ADB on reboot. A selected
      // USB cable may observe that return, but cannot inherit the old boot's
      // empty-MAC exception or hide an unauthorized/ambiguous Wi-Fi transport.
      if (!(error instanceof OtaHardwareUnavailable) || error.kind !== "transport" || !returnUsb) throw error
      const usbFixture = {...fixture, wifiEndpoint: undefined, usb: returnUsb}
      const usbTransport = selectUsbTransport(await inventory(), fixture.serial, returnUsb)
      const usbShell = (...args: string[]) => command(["adb", "-t", usbTransport, "shell", ...args])
      requireProof(
        (await usbShell("cat", "/sys/block/mmcblk0/device/cid")).toLowerCase() === fixture.cid.toLowerCase() &&
          (await usbShell("getprop", "ro.serialno")) === fixture.serial &&
          (await usbShell("getprop", "ro.boot.serialno")) === binding.bootSerial,
        "USB_RETURN_IDENTITY_MISMATCH",
      )
      const mac = await usbShell("getprop", "persist.mentra.live.mac")
      if (mac === "") throw new OtaHardwareUnavailable("boot", "USB return has not reported its Bluetooth identity yet")
      requireProof(mac.toUpperCase() === fixture.bluetooth.toUpperCase(), "USB_RETURN_BLUETOOTH_MISMATCH")
      const actual = await readOtaHardware(usbFixture, allowedFirmware, asgVersions, observingActivePass, command)
      if (!actual.bootId) throw new OtaHardwareUnavailable("boot", "USB return has not reported its boot identity yet")
      requireProof(
        UUID.test(actual.bootId) && actual.bootId !== binding.originalBoot && actual.firmware !== JANUARY,
        "USB_RETURN_MUST_BE_NEW_MODERN_BOOT",
      )
      requireProof(
        (await actual.shell("getprop", "ro.boot.serialno")) === binding.bootSerial &&
          (await actual.shell("cat", "/proc/sys/kernel/random/boot_id")) === actual.bootId &&
          actual.transport === usbTransport &&
          selectUsbTransport(await inventory(), fixture.serial, returnUsb) === actual.transport,
        "USB_RETURN_CHANGED_DURING_READ",
      )
      return actual
    }
    const shell = async (...args: string[]) => {
      try {
        return await command(["adb", "-t", transport, "shell", ...args])
      } catch (error) {
        if (
          error instanceof OtaCommandError &&
          selectWifiTransport(await inventory(), fixture.wifiEndpoint!) !== transport
        )
          throw new OtaHardwareUnavailable("transport", "Fixture reconnected")
        throw error
      }
    }
    const persistedBluetooth = await shell("getprop", "persist.mentra.live.mac")
    // The standard reader independently rereads and validates the real property.
    if (persistedBluetooth !== "")
      return readOtaHardware(selected, allowedFirmware, asgVersions, observingActivePass, command)
    const bootId = await shell("cat", "/proc/sys/kernel/random/boot_id")
    const cid = await shell("cat", "/sys/block/mmcblk0/device/cid")
    const serial = await shell("getprop", "ro.serialno")
    const bootSerial = await shell("getprop", "ro.boot.serialno")
    requireProof(
      cid.toLowerCase() === fixture.cid.toLowerCase() && serial === fixture.serial && bootSerial === binding.bootSerial,
      "CURRENT_IDENTITY_MISMATCH",
    )
    // The old identity binding cannot prove a new boot, but its missing MAC is
    // not a conflicting MAC. Observe the restart as unavailable until the real
    // property returns. Initial/final reads still throw and cannot pass here.
    if (bootId !== binding.originalBoot)
      throw new OtaHardwareUnavailable("boot", "New boot has not reported its Bluetooth identity yet")
    const firmware = normalizeFirmware(await shell("getprop", "ro.custom.ota.version"))
    const bootCompleted = await shell("getprop", "sys.boot_completed")
    const slot = await shell("getprop", "ro.boot.slot_suffix")
    requireProof(firmware === JANUARY && slot === binding.slot && bootCompleted === "1", "CURRENT_BOOT_NOT_JANUARY")
    const asgVersion = Number(/versionCode=(\d+)/.exec(await shell("dumpsys", "package", "com.mentra.asg_client"))?.[1])
    requireProof(hashes.has(asgVersion), "ASG_NOT_SUPPORTED_ON_EMPTY_PROPERTY")
    checkOtaObservedVersions(firmware, asgVersion, allowedFirmware, asgVersions, false)
    const readApkPath = async () => {
      const match = /^package:(\/[A-Za-z0-9_./+=~:-]+\.apk)$/.exec(await shell("pm", "path", "com.mentra.asg_client"))
      requireProof(match, "ACTIVE_APK_PATH_AMBIGUOUS")
      return match[1]
    }
    const apkPath = await readApkPath()
    const apkSha256 = (await shell("sha256sum", apkPath)).split(/\s+/)[0]
    requireProof(apkSha256 === hashes.get(asgVersion), "ACTIVE_APK_HASH_MISMATCH")
    // Bracket the complete evidence batch. No command is resent after ambiguity.
    requireProof(
      (await readApkPath()) === apkPath &&
        Number(/versionCode=(\d+)/.exec(await shell("dumpsys", "package", "com.mentra.asg_client"))?.[1]) ===
          asgVersion,
      "ACTIVE_APK_CHANGED_DURING_READ",
    )
    requireProof((await shell("getprop", "persist.mentra.live.mac")) === "", "PERSISTED_PROPERTY_CHANGED_DURING_READ")
    requireProof(
      (await shell("cat", "/sys/block/mmcblk0/device/cid")).toLowerCase() === fixture.cid.toLowerCase() &&
        (await shell("getprop", "ro.serialno")) === fixture.serial &&
        (await shell("getprop", "ro.boot.serialno")) === binding.bootSerial,
      "IDENTITY_CHANGED_DURING_READ",
    )
    assertOriginalBoot(await shell("cat", "/proc/sys/kernel/random/boot_id"))
    requireProof(
      selectWifiTransport(await inventory(), fixture.wifiEndpoint!) === transport,
      "TRANSPORT_CHANGED_DURING_READ",
    )
    return {
      transport,
      serial,
      cid,
      bluetooth: bridge.mac,
      firmware,
      bootId,
      slot,
      bootCompleted,
      asgVersion,
      shell,
      persistedBluetooth,
      bootSerial,
      apkPath,
      apkSha256,
      bluetoothProvenance: {
        kind: "original-January-boot BLE-to-WiFi-to-ADB recovery binding",
        config: baseline.config,
        activationResult: baseline.activationResult,
        recoveryAfter: baseline.recoveryAfter,
        owner: baseline.owner,
        endpoint: bridge.endpoint,
        ssidMatches: true,
        readStartedAt: startedAt,
        readCompletedAt: new Date().toISOString(),
        persistedPropertyObservedEmpty: true,
      },
    }
  }
  return {readHardware, originalBoot: binding.originalBoot, recoveryAfter: baseline.recoveryAfter}
}
