import {spawnSync} from "node:child_process"

function output(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {encoding: "utf8"})
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} ${commandArgs.join(" ")} failed`)
  }
  return result.stdout
}

export function listAuthorizedDevices() {
  return output("adb", ["devices", "-l"])
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/)
      const details = rest.join(" ")
      const model = details.match(/\bmodel:(\S+)/)?.[1]
      const product = details.match(/\bproduct:(\S+)/)?.[1]
      const device = details.match(/\bdevice:(\S+)/)?.[1]
      return {serial, state, model, product, device, line}
    })
    .filter((entry) => entry.state === "device")
}

/** Mentra Live / ASG glasses — never install the phone example app here. */
export function isGlassesDevice(device) {
  const blob = [
    device.serial,
    device.model,
    device.product,
    device.device,
    device.line,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()

  return (
    blob.includes("mentralive") ||
    blob.includes("mentra_live") ||
    blob.includes("mentra live") ||
    // MentraOS mobile/scripts/android.mjs uses the same broad "live" rule on adb -l lines.
    /\bmodel:.*live\b/.test(blob) ||
    /\bproduct:.*live\b/.test(blob)
  )
}

export function isEmulator(device) {
  const blob = `${device.serial} ${device.line}`.toLowerCase()
  return blob.includes("emulator") || device.serial.startsWith("emulator-")
}

export function isPhoneTarget(device) {
  return !isEmulator(device) && !isGlassesDevice(device)
}

/**
 * Pick a USB-connected Android phone for expo run:android / android:dev.
 * Skips Mentra Live glasses and emulators unless ALLOW_MENTRA_LIVE=1.
 */
export function resolveAndroidPhoneTarget() {
  const forcedSerial = process.env.ANDROID_SERIAL?.trim()
  const allowGlasses = process.env.ALLOW_MENTRA_LIVE === "1"
  const devices = listAuthorizedDevices()

  if (devices.length === 0) {
    throw new Error("No authorized Android device found. Connect a phone and accept the USB debugging prompt.")
  }

  const skipped = devices.filter((device) => !isPhoneTarget(device))
  if (skipped.length > 0) {
    const list = skipped
      .map((device) => {
        const kind = isGlassesDevice(device) ? "Mentra Live glasses" : "emulator"
        return `  - ${device.serial} (${device.model ?? "unknown"}) — skipped (${kind})`
      })
      .join("\n")
    console.log(`Skipping non-phone targets:\n${list}`)
  }

  if (forcedSerial) {
    const match = devices.find((device) => device.serial === forcedSerial)
    if (!match) {
      throw new Error(`ANDROID_SERIAL=${forcedSerial} is not an attached, authorized Android device.`)
    }
    if (!allowGlasses && !isPhoneTarget(match)) {
      throw new Error(
        `ANDROID_SERIAL=${forcedSerial} is Mentra Live glasses or an emulator. ` +
          "Connect your phone instead, or set ALLOW_MENTRA_LIVE=1 to override.",
      )
    }
    return match
  }

  const phones = devices.filter(isPhoneTarget)

  if (phones.length === 0) {
    const all = devices.map((device) => `  - ${device.serial} (${device.model ?? "unknown"})`).join("\n")
    throw new Error(
      "No Android phone found. Connect your phone via USB and accept debugging.\n" +
        `Connected devices:\n${all}\n` +
        "Tip: ANDROID_SERIAL=<phone-serial> bun run android:dev",
    )
  }

  if (phones.length > 1) {
    const list = phones.map((device) => `  - ${device.serial}  model:${device.model ?? "?"}`).join("\n")
    throw new Error(`Multiple phones connected. Set ANDROID_SERIAL to one of:\n${list}`)
  }

  return phones[0]
}

export function expoDeviceName(device) {
  return device.model || device.serial
}
