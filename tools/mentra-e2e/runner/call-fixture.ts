import {isAbsolute} from "node:path"

export interface CallFixture {
  schemaVersion: 1
  glasses: {
    serial: string
    usb: string
    cid: string
    firmware: string
    slot: "_a" | "_b"
    bluetooth: string
  }
  network: {wifiInterface: string; ethernetInterface: string}
  cleanup: {porterApp: string; project: string; cluster: string; target: string}
}

export function parseCallBuild(value: unknown) {
  const input = record(value, "installed build manifest")
  if (input.bundleId !== "com.mentra.mentra" || input.networkAdapter !== "mac-host-verified-test-only")
    throw new Error("Expected an installed Mentra Mac test-adapter build manifest")
  const launchPath = text(input.launchPath, "installed app path", /\.app$/)
  if (!isAbsolute(launchPath)) throw new Error("Installed app path must be absolute")
  return {
    launchPath,
    executableSha256: text(input.executableSha256, "executable hash", /^[a-f0-9]{64}$/),
    javascriptSha256: text(input.javascriptSha256, "JavaScript hash", /^[a-f0-9]{64}$/),
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Missing ${label}`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

/** Fixture files contain identities, never credentials or an ADB transport id. */
export function parseCallFixture(value: unknown): CallFixture {
  const input = record(value, "fixture")
  if (input.schemaVersion !== 1) throw new Error("Expected call fixture schemaVersion 1")
  const glasses = record(input.glasses, "glasses identity")
  const network = record(input.network, "network interfaces")
  const cleanup = record(input.cleanup, "owned meeting cleanup configuration")
  const result: CallFixture = {
    schemaVersion: 1,
    glasses: {
      serial: text(glasses.serial, "USB serial", /^[A-Za-z0-9_-]+$/),
      usb: text(glasses.usb, "USB topology", /^[A-Za-z0-9_.:-]+$/),
      cid: text(glasses.cid, "eMMC CID", /^[a-f0-9]{32}$/i).toLowerCase(),
      firmware: text(glasses.firmware, "MTK firmware", /^MentraLive_\d{8}\.\d+$/),
      slot: text(glasses.slot, "boot slot", /^_[ab]$/) as "_a" | "_b",
      bluetooth: text(glasses.bluetooth, "Bluetooth address", /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i).toUpperCase(),
    },
    network: {
      wifiInterface: text(network.wifiInterface, "Wi-Fi interface", /^en\d+$/),
      ethernetInterface: text(network.ethernetInterface, "Ethernet interface", /^en\d+$/),
    },
    cleanup: {
      porterApp: text(cleanup.porterApp, "Porter app", /^[a-z0-9][a-z0-9-]*$/),
      project: text(cleanup.project, "Porter project", /^[1-9]\d*$/),
      cluster: text(cleanup.cluster, "Porter cluster", /^[1-9]\d*$/),
      target: text(cleanup.target, "Porter target", /^[a-z0-9][a-z0-9-]*$/),
    },
  }
  if (result.network.wifiInterface === result.network.ethernetInterface)
    throw new Error("Wi-Fi and Ethernet must be separate interfaces")
  if (glasses.serial === "0123456789ABCDEF") throw new Error("A legacy generic USB serial is not a unique fixture")
  return result
}

export function verifyCallDevice(
  expected: CallFixture["glasses"],
  observed: Record<string, string>,
  pinnedBoot?: string,
): string {
  for (const key of ["serial", "cid", "firmware", "slot"] as const)
    if (observed[key] !== expected[key]) throw new Error(`Device identity changed: ${key}`)
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(observed.bootId ?? ""))
    throw new Error("No valid current boot identity")
  if (pinnedBoot && observed.bootId !== pinnedBoot) throw new Error("Device rebooted during the call routine")
  return observed.bootId
}

export function hasInterfaceRoute(output: string, name: string): boolean {
  return output.split("\n").some((line) => line.trim() === `interface: ${name}`)
}
