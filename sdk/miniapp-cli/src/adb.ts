/**
 * `adb reverse` plumbing for `mentra-miniapp dev --usb`.
 *
 * Over USB, `adb reverse tcp:P tcp:P` publishes the laptop's port P on the
 * phone's own loopback. That lets the dev QR advertise `127.0.0.1` instead of
 * a LAN IP, so the phone and the laptop no longer need to share a Wi-Fi
 * network (or survive AP client isolation). The phone-side launch probe
 * already tries loopback as a candidate host, so nothing downstream of the QR
 * needs to change.
 *
 * Every adb invocation goes through an injectable {@link AdbRunner} so the
 * parsing logic is unit-testable without a device attached.
 */

export interface AdbDevice {
  serial: string
  /** `device` = usable. `unauthorized` / `offline` / `recovery` are not. */
  state: string
}

export interface AdbRunResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type AdbRunner = (args: string[]) => AdbRunResult

/** Exit code Unix shells use for "command not found". */
const EXIT_NOT_FOUND = 127

const defaultRunner: AdbRunner = (args) => {
  try {
    const proc = Bun.spawnSync(["adb", ...args], {stdout: "pipe", stderr: "pipe"})
    return {
      exitCode: proc.exitCode ?? 1,
      stdout: proc.stdout ? new TextDecoder().decode(proc.stdout) : "",
      stderr: proc.stderr ? new TextDecoder().decode(proc.stderr) : "",
    }
  } catch (error) {
    // Bun throws ENOENT when the binary is missing rather than returning a
    // non-zero exit, so normalise that into the same shape.
    return {exitCode: EXIT_NOT_FOUND, stdout: "", stderr: (error as Error).message}
  }
}

export interface AdbOptions {
  /** Target a specific device serial (`adb -s`). Required when several are attached. */
  device?: string
  run?: AdbRunner
}

function withSerial(args: string[], serial?: string): string[] {
  return serial ? ["-s", serial, ...args] : args
}

/**
 * Parse `adb devices` output into serial/state pairs.
 *
 * Real-world output carries noise we have to drop: the `List of devices
 * attached` header and daemon chatter such as `* daemon not running; starting
 * now at tcp:5037 *`. States other than `device` (`unauthorized` when the RSA
 * prompt hasn't been accepted, `offline` mid-reconnect) are preserved here so
 * callers can explain *why* a device is unusable.
 */
export function parseAdbDevices(stdout: string): AdbDevice[] {
  const devices: AdbDevice[] = []
  for (const raw of stdout.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith("*")) continue
    if (line.toLowerCase().startsWith("list of devices")) continue
    if (line.toLowerCase().startsWith("adb server")) continue
    const parts = line.split(/\s+/)
    if (parts.length < 2) continue
    const [serial, state] = parts
    if (!serial || !state) continue
    devices.push({serial, state})
  }
  return devices
}

/**
 * Parse `adb reverse --list` output into the device-side ports currently
 * mapped. Lines look like `<serial> tcp:3000 tcp:3000`; the first port is the
 * one the phone dials, which is what we track.
 */
export function parseReverseList(stdout: string): number[] {
  const ports: number[] = []
  for (const raw of stdout.split("\n")) {
    const match = /tcp:(\d+)\s+tcp:(\d+)/.exec(raw)
    if (!match) continue
    const port = Number(match[1])
    if (Number.isFinite(port) && !ports.includes(port)) ports.push(port)
  }
  return ports
}

/** True when an `adb` binary is callable on PATH. */
export function hasAdb(run: AdbRunner = defaultRunner): boolean {
  return run(["version"]).exitCode === 0
}

export function listDevices(run: AdbRunner = defaultRunner): AdbDevice[] {
  const result = run(["devices"])
  if (result.exitCode !== 0) return []
  return parseAdbDevices(result.stdout)
}

export type DeviceSelection = {ok: true; serial: string | undefined} | {ok: false; reason: string}

/**
 * Mentra Live glasses advertise this generic Android serial over ADB. When a
 * phone is also attached, `adb reverse` without `-s` fails with "more than one
 * device" — skip the glasses and target the phone.
 */
export const IGNORED_USB_SERIALS = new Set(["0123456789ABCDEF"])

/**
 * Decide which attached device the tunnel should target.
 *
 * Returns an undefined serial when exactly one device is attached and no
 * explicit `--device` was passed — plain `adb reverse` already does the right
 * thing there, and omitting `-s` keeps the commands readable in logs.
 */
export function selectUsbDevice(devices: AdbDevice[], requested?: string): DeviceSelection {
  const usable = devices.filter((d) => d.state === "device")

  if (requested) {
    const match = devices.find((d) => d.serial === requested)
    if (!match) {
      const attached = devices.length > 0 ? devices.map((d) => d.serial).join(", ") : "none"
      return {ok: false, reason: `no attached device with serial "${requested}" (attached: ${attached})`}
    }
    if (match.state !== "device") {
      return {ok: false, reason: `device "${requested}" is in state "${match.state}", not "device"`}
    }
    return {ok: true, serial: requested}
  }

  if (usable.length === 1) return {ok: true, serial: undefined}

  if (usable.length > 1) {
    const preferred = usable.filter((d) => !IGNORED_USB_SERIALS.has(d.serial))
    // Phone + glasses: one real serial left. Pass it explicitly — omitting `-s`
    // would still see both devices and adb would refuse to reverse.
    if (preferred.length === 1) return {ok: true, serial: preferred[0]!.serial}
    const listed = (preferred.length > 0 ? preferred : usable).map((d) => d.serial)
    return {
      ok: false,
      reason: `${listed.length} devices attached (${listed.join(", ")}). Pass --device <serial> to pick one.`,
    }
  }

  // Nothing usable — explain the blocked states rather than just "no devices",
  // since an unaccepted RSA prompt is the most common cause.
  const blocked = devices.filter((d) => d.state !== "device")
  if (blocked.length > 0) {
    const detail = blocked.map((d) => `${d.serial} (${d.state})`).join(", ")
    return {
      ok: false,
      reason: `no usable device: ${detail}. Accept the USB debugging prompt on the device and retry.`,
    }
  }
  return {
    ok: false,
    reason:
      "no Android device attached. Connect the phone over USB with developer mode " +
      "and USB debugging enabled. (USB mode is Android-only; iOS has no adb.)",
  }
}

/** Map one laptop port onto the same port on the device's loopback. */
export function adbReverse(port: number, options: AdbOptions = {}): boolean {
  const run = options.run ?? defaultRunner
  return run(withSerial(["reverse", `tcp:${port}`, `tcp:${port}`], options.device)).exitCode === 0
}

export function adbReverseRemove(port: number, options: AdbOptions = {}): boolean {
  const run = options.run ?? defaultRunner
  return run(withSerial(["reverse", "--remove", `tcp:${port}`], options.device)).exitCode === 0
}

/**
 * Which of `ports` are NOT currently mapped.
 *
 * A failing `adb reverse --list` (device unplugged, adb server killed) means we
 * can't confirm anything, so every port counts as missing and the caller
 * re-asserts the whole set.
 */
export function missingReversePorts(ports: number[], options: AdbOptions = {}): number[] {
  const run = options.run ?? defaultRunner
  const result = run(withSerial(["reverse", "--list"], options.device))
  if (result.exitCode !== 0) return [...ports]
  const live = parseReverseList(result.stdout)
  return ports.filter((p) => !live.includes(p))
}

export type UsbTunnelResult = {ok: true; serial?: string} | {ok: false; reason: string}

/**
 * Establish reverse tunnels for every port in `ports`.
 *
 * Partial failure is rolled back: a half-open tunnel would serve the static
 * files but silently break live reload, which is harder to debug than a clean
 * up-front error.
 */
export function openUsbTunnel(ports: number[], options: AdbOptions = {}): UsbTunnelResult {
  const run = options.run ?? defaultRunner

  if (!hasAdb(run)) {
    return {
      ok: false,
      reason:
        "`adb` was not found on PATH. Install Android platform-tools " +
        "(e.g. `brew install --cask android-platform-tools`) and retry.",
    }
  }

  const selection = selectUsbDevice(listDevices(run), options.device)
  if (!selection.ok) return {ok: false, reason: selection.reason}

  const serial = selection.serial
  const opened: number[] = []
  for (const port of ports) {
    if (!adbReverse(port, {device: serial, run})) {
      for (const done of opened) adbReverseRemove(done, {device: serial, run})
      return {ok: false, reason: `\`adb reverse tcp:${port} tcp:${port}\` failed`}
    }
    opened.push(port)
  }

  return {ok: true, serial}
}

/** Best-effort teardown. Safe to call for ports that were never mapped. */
export function closeUsbTunnel(ports: number[], options: AdbOptions = {}): void {
  for (const port of ports) {
    try {
      adbReverseRemove(port, options)
    } catch {
      /* the device may already be gone — nothing to clean up */
    }
  }
}
