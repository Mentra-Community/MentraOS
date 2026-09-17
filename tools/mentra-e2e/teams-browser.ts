import {createInterface} from "node:readline"
import {parseArgs} from "node:util"
import {chmod, lstat, mkdir, readFile, writeFile} from "node:fs/promises"
import {homedir} from "node:os"
import {dirname, join, resolve} from "node:path"
import {chromium, type BrowserContext, type Page} from "playwright-core"
import {keepAwake} from "./runner/keep-awake"
import {finishBrowserEvidence, type BrowserChapter, type VideoCalibration} from "./runner/browser-evidence"
import {
  teamsMeetingUrl,
  teamsPhase,
  videoSamples,
  hasAdvancingVideo,
  hasDecodedVideo,
  reachTeamsPrejoin,
} from "./runner/teams-browser"
import {
  installMediaDiagnostics,
  sampleMediaDiagnostics,
  hasAdvancingLaptopMedia,
} from "./runner/browser-media-diagnostics"
import {parseTeamsDevices, selectTeamsDevices} from "./runner/teams-devices"

// Experimental browser companion. It does not qualify the native or duplex routine.
process.umask(0o077)
const {positionals, values} = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    "help": {type: "boolean", default: false},
    "meeting-url-file": {type: "string"},
    "output": {type: "string"},
    "headful": {type: "boolean", default: false},
    "rejoin": {type: "boolean", default: false},
    "capture-devices": {type: "string"},
    "audio-only": {type: "boolean", default: false},
    "name": {type: "string", default: "Mentra E2E Observer"},
    "remote-name": {type: "string", default: "Mentra Live"},
    "admission-seconds": {type: "string", default: "90"},
  },
})
if (values.help) {
  console.log(`Usage:
  bun tools/mentra-e2e/teams-browser.ts run --meeting-url-file PRIVATE_FILE [--output NEW_DIRECTORY]
  bun tools/mentra-e2e/teams-browser.ts setup [--meeting-url-file PRIVATE_FILE]
  bun tools/mentra-e2e/teams-browser.ts probe [--meeting-url-file PRIVATE_FILE]

Experimental incoming-video companion: the native host must create and admit the
guest. Does not qualify duplex audio or the full call routine. Run is headless
unless --headful is supplied; setup always opens normal Chrome for human sign-in.
Recordings and the dedicated profile stay local. See TEAMS-BROWSER-ROUTINE.md.`)
  process.exit(0)
}
const mode = positionals[0] ?? "probe"
const captureDevices = values["capture-devices"]
  ? parseTeamsDevices(JSON.parse(await readFile(values["capture-devices"], "utf8")))
  : undefined
if (values["audio-only"] && !captureDevices) throw new Error("Audio-only requires explicit laptop devices")
if (captureDevices && (mode !== "run" || (values.rejoin && !values["audio-only"])))
  throw new Error("Rejoin with laptop capture currently requires audio-only mode")
if (!["setup", "probe", "run"].includes(mode)) throw new Error("Use setup, probe or run")
const admissionSeconds = Number(values["admission-seconds"])
if (!Number.isFinite(admissionSeconds) || admissionSeconds < 1 || admissionSeconds > 300)
  throw new Error("Admission timeout must be between 1 and 300 seconds")
const profile = join(homedir(), ".cache", "mentra-e2e", "teams-chrome")
await mkdir(profile, {recursive: true, mode: 0o700})
if (!(await lstat(profile)).isDirectory() || (await lstat(profile)).isSymbolicLink())
  throw new Error("The test browser profile must be a real directory")
await chmod(profile, 0o700)
const output = values.output
  ? resolve(values.output)
  : resolve(
      import.meta.dir,
      "../../.test-results/mentra-e2e",
      new Date().toISOString().replace(/[:.]/g, "-") + "-teams-browser-" + mode,
    )
await mkdir(dirname(output), {recursive: true, mode: 0o700})
await mkdir(output, {mode: 0o700})
const meeting = values["meeting-url-file"]
  ? teamsMeetingUrl(await readFile(values["meeting-url-file"], "utf8"))
  : undefined
if (mode === "run" && !meeting) throw new Error("run requires --meeting-url-file")
const started = performance.now()
const events: BrowserChapter[] = []
let calibration: VideoCalibration | undefined
let videoPath: string | undefined
let videoTimeline: unknown = "not-recorded"
const awake = keepAwake()
let context: BrowserContext | undefined
let page: Page | undefined
let failure: string | undefined
let cleanup = "not-needed"
let joinRequested = false
let rejoinQualified = false
let browserSendingVerified = false
let audioDeviceSelections = 0
let freshLinkRecovery: {status: "passed" | "failed"; error?: string} | undefined
const browserErrors: {type: string; text: string}[] = []
const nativeInput = values.rejoin && mode === "run" ? createInterface({input: process.stdin}) : undefined
function nativeDepartureAcknowledged(publish: () => Promise<void>) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      nativeInput!.off("line", onLine)
      nativeInput!.off("close", onClose)
      error ? reject(error) : resolve()
    }
    const onLine = (line: string) => {
      if (line === "MENTRA_NATIVE_ACK browser-left") finish()
    }
    const onClose = () => finish(new Error("Native controller closed before checking browser departure"))
    const timer = setTimeout(() => finish(new Error("Native departure acknowledgement timed out")), 30000)
    nativeInput!.on("line", onLine)
    nativeInput!.once("close", onClose)
    void publish().catch(finish)
  })
}
process.once("SIGTERM", () => {
  failure ??= "Controller cancelled the browser routine"
  void context?.close().catch(() => {})
})
const elapsed = () => Math.round(performance.now() - started)
async function evidence(id: string, instruction: string) {
  if (/(?:^|-)device-(?:microphone|speaker)$/.test(id)) audioDeviceSelections++
  const phase = await teamsPhase(page!)
  const event = {id, instruction, elapsedMs: elapsed(), phase}
  events.push(event)
  // Authentication is a setup handoff, not a source of reusable secrets.
  if (phase !== "signin") {
    await page!.screenshot({path: join(output, `${id}.png`)})
    await writeFile(join(output, `${id}.yml`), await page!.locator("body").ariaSnapshot())
    await writeFile(join(output, `${id}-media.json`), JSON.stringify(await sampleMediaDiagnostics(page!), null, 2))
  }
  await writeFile(join(output, "steps.json"), JSON.stringify(events, null, 2))
  console.log(`${id}: ${phase} — ${instruction}`)
  console.log("MENTRA_BROWSER_EVENT " + JSON.stringify(event))
}
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chrome",
    headless: mode !== "setup" && !values.headful,
    chromiumSandbox: true,
    viewport: {width: 1280, height: 800},
    ...(mode === "run" ? {recordVideo: {dir: output, size: {width: 1280, height: 800}}} : {}),
  })
  await installMediaDiagnostics(context)
  if (captureDevices) await context.grantPermissions(["camera", "microphone"], {origin: "https://teams.microsoft.com"})
  // This context owns only the dedicated test profile, never personal Chrome tabs.
  page = context.pages()[0] ?? (await context.newPage())
  page.on("pageerror", (error) => {
    if (browserErrors.length < 200) browserErrors.push({type: "pageerror", text: String(error)})
  })
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()) && browserErrors.length < 200)
      browserErrors.push({type: message.type(), text: message.text()})
  })
  page.setDefaultTimeout(10000)
  if (mode === "run") {
    // This is our own blank calibration page, before any Teams content loads.
    await page.setContent('<body style="margin:0;background:white"></body>')
    await page.screenshot()
    await new Promise((resolve) => setTimeout(resolve, 500))
    const beforeMs = elapsed()
    await page.setContent('<body style="margin:0;background:#00ff00"></body>')
    await page.screenshot({path: join(output, "calibration.png")})
    calibration = {beforeMs, afterMs: elapsed()}
    await writeFile(join(output, "calibration.json"), JSON.stringify(calibration, null, 2))
    await new Promise((resolve) => setTimeout(resolve, 500))
    videoPath = await page.video()!.path()
  }
  await page.goto(meeting ?? "https://teams.microsoft.com/", {waitUntil: "domcontentloaded", timeout: 45000})
  if (mode === "setup") {
    console.log(
      "Complete normal Teams sign-in in the test Chrome window. No credentials or authentication video are recorded. Press Enter here when finished.",
    )
    const {createInterface} = await import("node:readline")
    const input = createInterface({input: process.stdin})
    const timeout = setTimeout(() => input.close(), 15 * 60 * 1000)
    try {
      for await (const _line of input) break
    } finally {
      clearTimeout(timeout)
      input.close()
    }
  } else {
    // A bounded load wait makes an unrecognized/sign-in page inspectable without guessing clicks.
    await page.waitForLoadState("networkidle", {timeout: 10000}).catch(() => {})
    await evidence("01-open", "Open the exact meeting link in the dedicated Teams browser profile.")
    if (mode === "run") {
      const runPage = page
      if ((await teamsPhase(runPage)) === "signin") throw new Error("SIGN_IN_REQUIRED: run setup before retrying")
      const withoutMedia = runPage.getByRole("button", {name: "Continue without audio or video", exact: true})
      const reachPrejoin = (prefix: string) => reachTeamsPrejoin(runPage, evidence, prefix)
      await reachPrejoin("01-")
      const name = runPage.getByRole("textbox", {name: "Type your name", exact: true})
      if (await name.isVisible()) await name.fill(values.name!)
      if (captureDevices) await selectTeamsDevices(runPage, captureDevices, evidence)
      async function verifyCaptureOff(prefix: string) {
        // Incoming-video qualification only. Leave selected hardware devices untouched.
        const camera = runPage.getByRole("switch", {name: /^Turn camera off/})
        if (await camera.isVisible()) await camera.click()
        const mic = runPage.getByRole("switch", {name: /^Mute mic/})
        if (await mic.isVisible()) await mic.click()
        const unavailableCamera = runPage.getByRole("switch", {name: "Camera is not available", exact: true})
        const unavailableMic = runPage.getByRole("switch", {name: "Mic is not available", exact: true})
        if (
          !(await runPage.getByRole("switch", {name: /^Turn camera on/}).isVisible()) &&
          !((await unavailableCamera.isVisible()) && (await unavailableCamera.isDisabled()))
        )
          throw new Error("Camera-off state could not be verified")
        if (
          !(await runPage.getByRole("switch", {name: /^Unmute mic/}).isVisible()) &&
          !((await unavailableMic.isVisible()) && (await unavailableMic.isDisabled()))
        )
          throw new Error("Microphone-off state could not be verified")
        await evidence(prefix + "prejoin", "Verify the browser participant is ready with camera and microphone off.")
      }
      await verifyCaptureOff("02-")
      joinRequested = true
      await runPage.getByRole("button", {name: "Join now", exact: true}).click()
      await evidence("03-join", "Join the meeting and classify lobby separately from admission.")
      async function waitForAdmission(prefix: string) {
        const deadline = performance.now() + admissionSeconds * 1000
        let reportedLobby = false
        while ((await teamsPhase(runPage)) !== "connected") {
          const phase = await teamsPhase(runPage)
          if (phase === "lobby" && !reportedLobby) {
            await evidence(prefix + "lobby", "Wait for the permitted host to admit this named guest.")
            reportedLobby = true
          }
          if (phase === "signin") throw new Error("SIGN_IN_REQUIRED")
          if (performance.now() > deadline) throw new Error(`ADMISSION_TIMEOUT: last phase ${phase}`)
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        await evidence(prefix + "admitted", "Verify the browser exposes the connected-call Leave control.")
      }
      await waitForAdmission("initial-")
      async function verifyIncomingVideo(prefix: string) {
        const unavailableCamera = runPage.getByRole("button", {name: "No available camera found", exact: true})
        const unavailableMic = runPage.getByRole("button", {name: "No audio devices available", exact: true})
        if (
          !(await runPage.getByRole("button", {name: /^Turn camera on/}).isVisible()) &&
          !((await unavailableCamera.isVisible()) && (await unavailableCamera.isDisabled()))
        )
          throw new Error("Connected browser camera-off state is not verified")
        if (
          !(await runPage.getByRole("button", {name: /^Unmute mic/}).isVisible()) &&
          !((await unavailableMic.isVisible()) && (await unavailableMic.isDisabled()))
        )
          throw new Error("Connected browser microphone-off state is not verified")
        await runPage
          .getByRole("menuitem", {name: values["remote-name"]! + " (Unverified)", exact: true})
          .waitFor({state: "visible", timeout: 20000})
        // The participant tile can precede the first decoded frame. Preserve this
        // bounded readiness wait separately from the playback progression check.
        const readiness: {elapsedMs: number; samples: Awaited<ReturnType<typeof videoSamples>>}[] = []
        const videoDeadline = performance.now() + 20000
        let before = await videoSamples(runPage)
        while (!hasDecodedVideo(before)) {
          readiness.push({elapsedMs: elapsed(), samples: before})
          await writeFile(join(output, prefix + "video-readiness.json"), JSON.stringify(readiness, null, 2))
          if (performance.now() >= videoDeadline) throw new Error("No decoded incoming video arrived within 20 seconds")
          await new Promise((resolve) => setTimeout(resolve, 250))
          before = await videoSamples(runPage)
        }
        readiness.push({elapsedMs: elapsed(), samples: before})
        await writeFile(join(output, prefix + "video-readiness.json"), JSON.stringify(readiness, null, 2))
        await evidence(prefix + "first-frame", "Wait for the first decoded frame from the glasses participant.")
        await new Promise((resolve) => setTimeout(resolve, 5000))
        const after = await videoSamples(runPage)
        await writeFile(join(output, prefix + "video-samples.json"), JSON.stringify({before, after}, null, 2))
        if (!hasAdvancingVideo(before, after)) throw new Error("No advancing incoming video was observed")
        await evidence(prefix + "video", "Verify advancing remote video with the laptop camera off.")
      }
      await verifyIncomingVideo("initial-")
      if (captureDevices) {
        const before = await sampleMediaDiagnostics(runPage)
        await runPage.getByRole("button", {name: /^Unmute mic/}).click()
        if (!values["audio-only"]) await runPage.getByRole("button", {name: /^Turn camera on/}).click()
        await runPage.getByRole("button", {name: /^Mute mic/}).waitFor({state: "visible"})
        await runPage
          .getByRole("button", {name: values["audio-only"] ? /^Turn camera on/ : /^Turn camera off/})
          .waitFor({state: "visible"})
        const deadline = performance.now() + 20000
        let after = await sampleMediaDiagnostics(runPage)
        while (!hasAdvancingLaptopMedia(before, after, captureDevices, values["audio-only"])) {
          await writeFile(join(output, "laptop-sending.json"), JSON.stringify({before, after}, null, 2))
          if (performance.now() > deadline)
            throw new Error("Selected laptop tracks and outbound RTP did not become active")
          await new Promise((resolve) => setTimeout(resolve, 250))
          after = await sampleMediaDiagnostics(runPage)
        }
        await new Promise((resolve) => setTimeout(resolve, 5000))
        const sustained = await sampleMediaDiagnostics(runPage)
        await writeFile(join(output, "laptop-sending.json"), JSON.stringify({before, after, sustained}, null, 2))
        if (!hasAdvancingLaptopMedia(after, sustained, captureDevices, values["audio-only"]))
          throw new Error("Laptop RTP did not keep advancing")
        browserSendingVerified = true
        await evidence(
          "laptop-sending",
          values["audio-only"]
            ? "Verify the selected laptop microphone and sustained outgoing audio packets with camera off."
            : "Verify selected laptop capture tracks and sustained outgoing audio/video packets.",
        )
        if (values["audio-only"]) await runPage.getByRole("button", {name: /^Mute mic/}).click()
      }
      if (values.rejoin) {
        await runPage.getByRole("button", {name: "Leave", exact: true}).click()
        await runPage.getByRole("button", {name: /^Rejoin(?: meeting)?$/}).waitFor({state: "visible", timeout: 10000})
        cleanup = "left"
        await nativeDepartureAcknowledged(() =>
          evidence(
            "browser-left",
            "Leave and wait for the native roster to verify zero participants before rejoining.",
          ),
        )
        await runPage.getByRole("button", {name: /^Rejoin(?: meeting)?$/}).click()
        cleanup = "not-needed"
        await evidence("rejoin-requested", "Rejoin this same meeting while the glasses stream continues.")
        const rejoinDeadline = performance.now() + 30000
        let continuedWithoutMedia = false
        while ((await teamsPhase(runPage)) === "unknown") {
          if (performance.now() > rejoinDeadline) throw new Error("Rejoin did not reach a recognized state")
          if (!continuedWithoutMedia && (await withoutMedia.isVisible())) {
            await evidence("rejoin-no-capture", "Continue the browser rejoin without camera or microphone capture.")
            await withoutMedia.click()
            continuedWithoutMedia = true
          }
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        if ((await teamsPhase(runPage)) === "prejoin") {
          if (await name.isVisible()) await name.fill(values.name!)
          if (captureDevices)
            await selectTeamsDevices(runPage, captureDevices, (id, text) => evidence("rejoin-" + id, text))
          await verifyCaptureOff("rejoin-")
          await runPage.getByRole("button", {name: "Join now", exact: true}).click()
        }
        await waitForAdmission("rejoin-")
        try {
          await verifyIncomingVideo("rejoin-")
          rejoinQualified = true
        } catch (error) {
          // Keep the Rejoin failure, even if reopening the link later recovers.
          // This comparison uses the same meeting and continuously running glasses stream.
          failure = String(error)
          process.exitCode = 1
          await evidence("rejoin-failure", "Record the failed Rejoin check before trying a fresh page load.")
          const people = runPage.getByRole("button", {name: "People", exact: true})
          if (await people.isVisible()) {
            await people.click()
            await evidence("rejoin-people", "Inspect which participants Teams actually lists after rejoin.")
          }
          try {
            await runPage.getByRole("button", {name: "Leave", exact: true}).click()
            await runPage
              .getByRole("button", {name: /^Rejoin(?: meeting)?$/})
              .waitFor({state: "visible", timeout: 10000})
            cleanup = "left"
            await nativeDepartureAcknowledged(() =>
              evidence("recovery-left", "Verify native departure before opening the same meeting link again."),
            )
            await runPage.goto(meeting!, {waitUntil: "domcontentloaded", timeout: 30000})
            await evidence(
              "recovery-open",
              "Open the original meeting link in a fresh page load without restarting the glasses stream.",
            )
            await reachPrejoin("recovery-")
            if (await name.isVisible()) await name.fill(values.name!)
            if (captureDevices)
              await selectTeamsDevices(runPage, captureDevices, (id, text) => evidence("recovery-" + id, text))
            await verifyCaptureOff("recovery-")
            cleanup = "not-needed"
            await runPage.getByRole("button", {name: "Join now", exact: true}).click()
            await waitForAdmission("recovery-")
            await verifyIncomingVideo("recovery-")
            freshLinkRecovery = {status: "passed"}
          } catch (recoveryError) {
            freshLinkRecovery = {status: "failed", error: String(recoveryError)}
            await evidence("recovery-failure", "Preserve the fresh-link comparison failure.")
          }
        }
      }
    }
  }
} catch (error) {
  // Keep URLs/opaque browser errors in private evidence, not the console.
  failure = String(error)
  if (page) await evidence("failure", "Preserve the failing browser state.").catch(() => {})
  console.error("Teams browser check failed; see the private result.json.")
  process.exitCode = 1
} finally {
  if (page && mode === "run") {
    try {
      const phase = await teamsPhase(page)
      if (phase === "connected") {
        await page.getByRole("button", {name: "Leave", exact: true}).click()
        await page.getByRole("button", {name: /^Rejoin(?: meeting)?$/}).waitFor({state: "visible", timeout: 10000})
        cleanup = "left"
      } else if (phase === "left") {
        cleanup = "left"
      } else if (phase === "lobby") {
        await page.getByRole("button", {name: "Cancel", exact: true}).click()
        cleanup = "cancelled-lobby"
      }
      if (joinRequested && cleanup === "not-needed") cleanup = "context-closed-state-unverified"
      await evidence("07-finish", "Leave the browser side and retain cleanup evidence.")
    } catch (error) {
      cleanup = "failed"
      failure ??= String(error)
      process.exitCode = 1
    }
  }
  nativeInput?.close()
  if (captureDevices) await context?.clearPermissions().catch(() => {})
  await context?.close().catch((error) => {
    failure ??= String(error)
    process.exitCode = 1
  })
  if (mode === "run" && videoPath && calibration) {
    try {
      videoTimeline = await finishBrowserEvidence(output, videoPath, calibration, events)
    } catch (error) {
      failure ??= String(error)
      process.exitCode = 1
      videoTimeline = {status: "failed", error: String(error)}
    }
  }
  await awake.stop()
  await writeFile(join(output, "browser-errors.json"), JSON.stringify(browserErrors, null, 2))
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      {
        mode,
        status: failure ? "failed" : mode === "run" ? "incoming-video-passed" : "inspected",
        failure,
        cleanup,
        elapsedMs: elapsed(),
        events,
        modelCalls: 0,
        duplexQualified: false,
        rejoinRequested: values.rejoin,
        rejoinQualified,
        captureDevices,
        browserSendingVerified,
        captureScope: captureDevices ? (values["audio-only"] ? "audio-only" : "audio-and-video") : "none",
        freshLinkRecovery,
        audioDeviceSelections,
        videoTimeline,
        profile: "dedicated local profile; excluded from evidence",
      },
      null,
      2,
    ),
  )
  console.log(`Evidence: ${output}`)
}
