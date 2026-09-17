import {parseArgs} from "node:util"
import {chmod, lstat, mkdir, writeFile} from "node:fs/promises"
import {homedir} from "node:os"
import {dirname, join, resolve} from "node:path"
import {chromium} from "playwright-core"

// This opens only the explicitly selected local tracks. It never joins a meeting.
process.umask(0o077)
const {positionals, values} = parseArgs({
  allowPositionals: true,
  options: {
    "microphone-label": {type: "string"},
    "camera-label": {type: "string"},
    "output": {type: "string"},
  },
})
const mode = positionals[0] ?? "devices"
if (!["devices", "check"].includes(mode)) throw new Error("Use devices or check")
if (mode === "check" && (!values["microphone-label"] || !values["camera-label"]))
  throw new Error("check requires exact --microphone-label and --camera-label values from devices")
const profile = join(homedir(), ".cache/mentra-e2e/teams-chrome")
await mkdir(profile, {recursive: true, mode: 0o700})
const stat = await lstat(profile)
if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Expected a real private browser profile directory")
await chmod(profile, 0o700)
const output = resolve(
  values.output ??
    join(
      import.meta.dir,
      "../../.test-results/mentra-e2e",
      new Date().toISOString().replace(/[:.]/g, "-") + "-browser-media-preflight",
    ),
)
await mkdir(dirname(output), {recursive: true, mode: 0o700})
await mkdir(output, {mode: 0o700})
const context = await chromium.launchPersistentContext(profile, {
  channel: "chrome",
  headless: true,
  chromiumSandbox: true,
})
const watchdog = setTimeout(() => void context.close().catch(() => {}), 45000)
let result: Record<string, unknown>
try {
  // Browser-origin permission only; macOS still enforces its ordinary media permissions.
  await context.grantPermissions(["camera", "microphone"], {origin: "https://teams.microsoft.com"})
  const page = context.pages()[0] ?? (await context.newPage())
  await page.goto("https://teams.microsoft.com/", {waitUntil: "domcontentloaded", timeout: 30000})
  result = await page.evaluate(
    async ({mode, microphone, camera}) => {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const summary = devices.map((d) => ({kind: d.kind, label: d.label}))
      if (mode === "devices") return {status: "enumerated", devices: summary}
      const select = (kind: MediaDeviceKind, label: string) => {
        const matches = devices.filter(
          (d) => d.kind === kind && d.label === label && d.deviceId !== "default" && d.deviceId !== "communications",
        )
        if (matches.length !== 1) throw new Error(`Expected one non-default ${kind} named ${label}`)
        return matches[0].deviceId
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {deviceId: {exact: select("audioinput", microphone!)}},
        video: {deviceId: {exact: select("videoinput", camera!)}},
      })
      try {
        const tracks = stream
          .getTracks()
          .map((t) => ({kind: t.kind, label: t.label, readyState: t.readyState, enabled: t.enabled}))
        if (tracks.length !== 2 || tracks.some((t) => t.readyState !== "live" || !t.enabled))
          throw new Error("Selected capture tracks are not live")
        return {status: "selected-capture-opened", devices: summary, tracks}
      } finally {
        stream.getTracks().forEach((t) => t.stop())
      }
    },
    {mode, microphone: values["microphone-label"], camera: values["camera-label"]},
  )
} catch (error) {
  result = {status: "failed", error: String(error)}
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  await context.clearPermissions().catch(() => {})
  await context.close()
}
await writeFile(
  join(output, "result.json"),
  JSON.stringify(
    {
      ...result,
      meetingJoined: false,
      glassesStreamsStarted: 0,
      systemAudioDeviceChanges: 0,
      requestedMicrophone: values["microphone-label"],
      requestedCamera: values["camera-label"],
      capturesClosed: true,
      recordedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
  {mode: 0o600},
)
console.log(JSON.stringify({status: result.status, evidence: output}))
