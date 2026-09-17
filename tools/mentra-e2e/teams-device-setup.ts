import {parseArgs} from "node:util"
import {mkdir, readFile, writeFile} from "node:fs/promises"
import {homedir} from "node:os"
import {join, resolve} from "node:path"
import {chromium} from "playwright-core"
import {reachTeamsJoinState, teamsMeetingUrl} from "./runner/teams-browser"
import {parseTeamsDevices, selectTeamsDevices} from "./runner/teams-devices"
import {installMediaDiagnostics, sampleMediaDiagnostics} from "./runner/browser-media-diagnostics"

// Rehearse the exact device controls without ever pressing Join now.
process.umask(0o077)
const {values} = parseArgs({
  options: {
    "meeting-url-file": {type: "string"},
    "devices-file": {type: "string"},
    "output": {type: "string"},
  },
})
if (!values["meeting-url-file"] || !values["devices-file"] || !values.output)
  throw new Error("Require --meeting-url-file, --devices-file and a new --output directory")
const meeting = teamsMeetingUrl(await readFile(values["meeting-url-file"], "utf8"))
const devices = parseTeamsDevices(JSON.parse(await readFile(values["devices-file"], "utf8")))
const output = resolve(values.output)
await mkdir(output, {mode: 0o700})
const context = await chromium.launchPersistentContext(join(homedir(), ".cache/mentra-e2e/teams-chrome"), {
  channel: "chrome",
  headless: true,
  chromiumSandbox: true,
  viewport: {width: 1280, height: 800},
})
let capturesClosed = false
let timedOut = false
let closeError: string | undefined
let closing: Promise<void> | undefined
const closeContext = () =>
  (closing ??= context.close().then(
    () => {
      capturesClosed = true
    },
    (error) => {
      closeError = String(error)
    },
  ))
const timeout = setTimeout(() => {
  timedOut = true
  void closeContext()
}, 60000)
let result: Record<string, unknown> = {status: "failed", error: "Setup did not complete"}
try {
  await installMediaDiagnostics(context)
  const page = context.pages()[0] ?? (await context.newPage())
  page.setDefaultTimeout(10000)
  const evidence = async (id: string, instruction: string) => {
    await page.screenshot({path: join(output, id + ".png")})
    await writeFile(join(output, id + ".yml"), await page.locator("body").ariaSnapshot())
    console.log(instruction)
  }
  await context.grantPermissions(["camera", "microphone"], {origin: "https://teams.microsoft.com"})
  await page.goto(meeting, {waitUntil: "domcontentloaded"})
  await reachTeamsJoinState(page, evidence, "prepare-")
  await page.getByRole("textbox", {name: "Type your name", exact: true}).fill("Mentra E2E Observer")
  await selectTeamsDevices(page, devices, evidence)
  const deadline = Date.now() + 10000
  while (true) {
    const samples = await sampleMediaDiagnostics(page)
    await writeFile(join(output, "selected-capture-tracks.json"), JSON.stringify(samples, null, 2))
    if (
      [devices.camera].every((label) =>
        samples.some((frame) =>
          frame.captures?.some(
            (track: any) => track.label === label && track.readyState === "live" && track.enabled && !track.muted,
          ),
        ),
      )
    )
      break
    if (Date.now() > deadline) throw new Error("Selected camera track did not open in Teams prejoin")
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const mute = page.getByRole("switch", {name: /^Mute mic/})
  if (await mute.isVisible()) await mute.click()
  await page.getByRole("switch", {name: /^Turn camera off/}).click()
  await page.getByRole("switch", {name: /^Unmute mic/}).waitFor({state: "visible"})
  await page.getByRole("switch", {name: /^Turn camera on/}).waitFor({state: "visible"})
  await evidence("prepared", "Verify laptop devices selected, camera and microphone off, without joining.")
  result = {
    status: "prejoin-device-controls-passed",
    devices,
    cameraCaptureVerified: true,
    microphoneSelectionVerified: true,
    microphoneCaptureVerified: false,
  }
} catch (error) {
  result = {status: "failed", error: String(error)}
  process.exitCode = 1
  const page = context.pages()[0]
  if (page) {
    await page.screenshot({path: join(output, "failure.png")}).catch(() => {})
    await writeFile(
      join(output, "failure.yml"),
      await page
        .locator("body")
        .ariaSnapshot()
        .catch(() => "unavailable"),
    )
  }
} finally {
  clearTimeout(timeout)
  // Persist the assessment before cleanup: a stalled close must not erase it or
  // imply that physical capture tracks were released.
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      {
        ...result,
        status: "cleanup-pending",
        assessmentBeforeCleanup: result.status,
        meetingJoined: false,
        glassesStreamsStarted: 0,
        capturesClosed: false,
      },
      null,
      2,
    ),
  )
  await context.clearPermissions().catch(() => {})
  await closeContext()
}
if (timedOut || closeError) {
  result = {...result, status: "failed", cleanupError: closeError, timedOut}
  process.exitCode = 1
}
await writeFile(
  join(output, "result.json"),
  JSON.stringify(
    {
      ...result,
      meetingJoined: false,
      glassesStreamsStarted: 0,
      systemAudioDeviceChanges: 0,
      capturesClosed,
    },
    null,
    2,
  ),
)
console.log(output)
