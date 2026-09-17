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
    "camera-setting-label": {type: "string"},
    "output": {type: "string"},
  },
})
const mode = positionals[0] ?? "devices"
if (!["devices", "check", "configure"].includes(mode)) throw new Error("Use devices, check or configure")
if (mode !== "devices" && (!values["microphone-label"] || !values["camera-label"]))
  throw new Error("check requires exact --microphone-label and --camera-label values from devices")
if (mode === "configure" && !values["camera-setting-label"])
  throw new Error("configure also requires the exact Chrome --camera-setting-label")
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
  const page = context.pages()[0] ?? (await context.newPage())
  if (mode === "configure") {
    // Use Chrome's normal settings UI inside the dedicated test profile. This does not
    // change macOS defaults or silently select the default alias (which may be glasses).
    for (const [kind, title, label] of [
      ["microphone", "Microphone", values["microphone-label"]!],
      ["camera", "Camera", values["camera-setting-label"]!],
    ]) {
      await page.goto(`chrome://settings/content/${kind}`)
      const choice = page.getByRole("combobox", {name: title, exact: true})
      await choice.waitFor({state: "visible", timeout: 10000})
      await page.screenshot({path: join(output, `${kind}-before.png`)})
      await writeFile(join(output, `${kind}-before.yml`), await page.locator("body").ariaSnapshot())
      if ((await choice.getByRole("option", {name: label, exact: true}).count()) !== 1)
        throw new Error(`Expected exactly one Chrome ${kind} option named ${label}`)
      await choice.selectOption({label})
      if ((await choice.locator("option:checked").textContent()) !== label)
        throw new Error(`Chrome did not select the requested ${kind}`)
      await page.screenshot({path: join(output, `${kind}-after.png`)})
      await writeFile(join(output, `${kind}-after.yml`), await page.locator("body").ariaSnapshot())
    }
  }
  // Browser-origin permission only; macOS still enforces its ordinary media permissions.
  await context.grantPermissions(["camera", "microphone"], {origin: "https://teams.microsoft.com"})
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
      const constraints =
        mode === "configure"
          ? {audio: true, video: true}
          : {
              audio: {deviceId: {exact: select("audioinput", microphone!)}},
              video: {deviceId: {exact: select("videoinput", camera!)}},
            }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      try {
        const tracks = stream
          .getTracks()
          .map((t) => ({kind: t.kind, label: t.label, readyState: t.readyState, enabled: t.enabled}))
        if (tracks.length !== 2 || tracks.some((t) => t.readyState !== "live" || !t.enabled))
          throw new Error("Selected capture tracks are not live")
        if (
          tracks.find((t) => t.kind === "audio")?.label !== microphone ||
          tracks.find((t) => t.kind === "video")?.label !== camera
        )
          throw new Error("The browser opened different capture devices than requested")
        return {
          status: "selected-capture-opened",
          defaultCaptureVerified: mode === "configure",
          devices: summary,
          tracks,
        }
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
