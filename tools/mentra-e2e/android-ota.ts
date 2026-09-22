import {parseArgs} from "node:util"
import {readFile, writeFile} from "node:fs/promises"
import {join} from "node:path"
import {AndroidSession} from "./runner/android-session"
import {verifyAndroidHardware, type AndroidRig} from "./runner/android-hardware"

const {values} = parseArgs({
  args: process.argv.slice(2),
  options: {
    fixture: {type: "string"},
    output: {type: "string"},
    install: {type: "boolean", default: false},
  },
})
if (!values.fixture || !values.output)
  throw new Error(
    "Usage: bun tools/mentra-e2e/android-ota.ts --fixture rig.json --output NEW_RUN_DIRECTORY [--install]",
  )
const rig: AndroidRig = JSON.parse(await readFile(values.fixture, "utf8"))
const run = new AndroidSession(rig.phone, rig.display, "Android OTA Update", values.output)
let status: "passed" | "failed" = "failed"
let failure: string | undefined
try {
  await run.start()
  let before: Awaited<ReturnType<typeof verifyAndroidHardware>> | undefined
  await run.step(
    "OTA-01",
    "Verify the phone, 03BE connections, USB identity and pinned update targets.",
    "The installed phone APK and both glasses transports match the fixture.",
    async () => {
      before = await verifyAndroidHardware(rig, false)
      await writeFile(join(run.directory, "hardware-before.json"), JSON.stringify(before, null, 2) + "\n")
    },
  )
  if (!before!.current) {
    if (!values.install)
      throw new Error("Mandatory update needed. Re-run the OTA routine with --install; Call cannot proceed.")
    await run.step(
      "OTA-02",
      "Start the offered mandatory update through the Mentra App.",
      "The app leaves the update offer.",
      async () => {
        await run.flow("OTA-02", [{assertVisible: "Mentra Live Update Available"}, {tapOn: {id: "button-Update Now"}}])
      },
    )
    const deadline = Date.now() + 25 * 60_000
    let last = "",
      index = 0,
      complete = false
    while (Date.now() < deadline) {
      const state = await run.snapshot()
      const labels = state.nodes.map((n) => n.text || n.description)
      const failure = ["Update Failed", "Check Failed", "Updates Blocked", "Update Info Unavailable"].find((t) =>
        labels.includes(t),
      )
      if (failure) throw new Error(failure)
      const text = labels.filter(Boolean).join(" / ")
      if (text !== last) {
        last = text
        await run.step(`OTA-PROGRESS-${++index}`, "Observe the current update stage.", text, async () => {})
      }
      if (
        labels.includes("Your glasses are running the latest version.") &&
        (labels.includes("Update Complete") || labels.includes("Up to Date"))
      ) {
        complete = true
        break
      }
      await Bun.sleep(1000)
    }
    if (!complete) throw new Error("OTA observation timed out; the app and update were left running, without retrying")
  }
  await run.step(
    "OTA-03",
    before!.current
      ? "Verify all mandatory targets are already installed."
      : "Independently verify the installed ASG APK, MTK and fresh BES response.",
    "All targets match the pinned manifest and the glasses identity is unchanged.",
    async () => {
      const after = await verifyAndroidHardware(rig, true)
      await writeFile(join(run.directory, "hardware-after.json"), JSON.stringify(after, null, 2) + "\n")
    },
  )
  await run.step(
    "OTA-04",
    "Finish the update and confirm paired home for the separate Call routine.",
    "Mentra Live and Settings are visible at home.",
    async () => {
      const state = await run.snapshot()
      if (state.nodes.some((n) => n.id === "button-Done")) {
        if (!state.nodes.some((n) => n.text === "Your glasses are running the latest version."))
          throw new Error("Done appears on an unverified update state")
        await run.flow("OTA-04-finish", [{tapOn: {id: "button-Done"}}])
      }
      await run.flow("OTA-04-home", [{assertVisible: "Mentra Live"}, {assertVisible: "Settings"}])
    },
  )
  status = "passed"
} catch (error) {
  failure = String(error)
  console.error(failure)
  process.exitCode = 1
} finally {
  await run.finish(status, {installationRequested: values.install, callStarted: false, error: failure})
}
