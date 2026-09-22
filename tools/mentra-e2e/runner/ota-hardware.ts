import {
  checkOtaObservedFirmware,
  checkOtaObservedVersions,
  OtaHardwareUnavailable,
  OtaValidationError,
  selectUsbTransport,
  selectWifiTransport,
} from "./ota-state"

export class OtaCommandError extends Error {}

export async function otaCommand(args: string[]): Promise<string> {
  const child = Bun.spawn(args, {stdout: "pipe", stderr: "pipe"})
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, 10000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (timedOut) throw new OtaCommandError(`${args[0]} timed out`)
    if (code) throw new OtaCommandError(`${args[0]} failed: ${stderr.slice(0, 200)}`)
    return stdout.trim()
  } finally {
    clearTimeout(timer)
  }
}

export type OtaFixture = {serial: string; usb?: string; wifiEndpoint?: string; cid: string; bluetooth: string}

function selectTransport(inventory: string, fixture: OtaFixture) {
  if (Boolean(fixture.usb) === Boolean(fixture.wifiEndpoint))
    throw new OtaValidationError("Select exactly one USB path or verified Wi-Fi endpoint")
  return fixture.wifiEndpoint
    ? selectWifiTransport(inventory, fixture.wifiEndpoint)
    : selectUsbTransport(inventory, fixture.serial, fixture.usb!)
}

/** A failed shell read is reconnect downtime only when fresh inventory proves a transport change. */
export async function readOtaHardware(
  fixture: OtaFixture,
  allowedFirmware: string[],
  asgVersions: number[],
  observingActivePass: boolean,
  run = otaCommand,
) {
  const inventory = () => run(["adb", "devices", "-l"])
  const transport = selectTransport(await inventory(), fixture)
  const shell = async (...args: string[]) => {
    try {
      return await run(["adb", "-t", transport, "shell", ...args])
    } catch (error) {
      if (error instanceof OtaCommandError) {
        // If it is still connected, this is a command failure, not proven transport downtime.
        const current = selectTransport(await inventory(), fixture)
        if (current !== transport) throw new OtaHardwareUnavailable("transport", "Fixture reconnected")
      }
      throw error
    }
  }
  const cid = await shell("cat", "/sys/block/mmcblk0/device/cid")
  const serial = await shell("getprop", "ro.serialno")
  if (cid.toLowerCase() !== fixture.cid.toLowerCase() || serial !== fixture.serial)
    throw new OtaValidationError("HARDWARE_IDENTITY_MISMATCH")
  const bluetooth = await shell("getprop", "persist.mentra.live.mac")
  if (bluetooth.toUpperCase() !== fixture.bluetooth.toUpperCase())
    throw new OtaValidationError("HARDWARE_BLUETOOTH_MISMATCH")
  const observedFirmware = await shell("getprop", "ro.custom.ota.version")
  // Validate successful nonempty reads before another command can encounter a reboot.
  let firmware = observedFirmware ? checkOtaObservedFirmware(observedFirmware, allowedFirmware) : undefined
  const bootCompleted = await shell("getprop", "sys.boot_completed")
  if (!observedFirmware && bootCompleted !== "1")
    throw new OtaHardwareUnavailable("boot", "Firmware property is not yet available during boot")
  firmware ??= checkOtaObservedFirmware(observedFirmware, allowedFirmware)
  const bootId = await shell("cat", "/proc/sys/kernel/random/boot_id")
  const slot = await shell("getprop", "ro.boot.slot_suffix")
  const packageInfo = await shell("dumpsys", "package", "com.mentra.asg_client")
  const asgVersion = Number(/versionCode=(\d+)/.exec(packageInfo)?.[1])
  if (!asgVersion && bootCompleted !== "1")
    throw new OtaHardwareUnavailable("boot", "ASG is not yet available during boot")
  checkOtaObservedVersions(firmware, asgVersion, allowedFirmware, asgVersions, observingActivePass)
  return {transport, serial, cid, bluetooth, firmware, bootId, slot, bootCompleted, asgVersion, shell}
}

/** Validation and evidence-write failures are terminal, even if a later poll could succeed. */
export async function observeOtaHardware<T>(
  read: () => Promise<T>,
  unavailable: (error: OtaHardwareUnavailable) => Promise<void>,
) {
  try {
    return await read()
  } catch (error) {
    if (!(error instanceof OtaHardwareUnavailable)) throw error
    await unavailable(error)
    return undefined
  }
}
