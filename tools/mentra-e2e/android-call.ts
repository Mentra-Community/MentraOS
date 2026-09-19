#!/usr/bin/env bun
import {readFile, writeFile} from "node:fs/promises"
import {join} from "node:path"
import {parseArgs} from "node:util"
import {verifyAndroidHardware, type AndroidRig} from "./runner/android-hardware"
import {AndroidSession} from "./runner/android-session"

const {positionals, values} = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {fixture: {type: "string"}, output: {type: "string"}},
})
if (positionals[0] !== "prepare" || !values.fixture || !values.output)
  throw new Error("Usage: bun tools/mentra-e2e/android-call.ts prepare --fixture rig.json --output NEW_RUN_DIRECTORY")

const rig: AndroidRig = JSON.parse(await readFile(values.fixture, "utf8"))
const run = new AndroidSession(rig.phone, rig.display, "Android Mentra Call preparation — no OTA", values.output)
const title = "Mentra E2E " + new Date().toISOString().replace(/[:.]/g, "-")
let status: "passed" | "failed" = "failed"
let failure: string | undefined
try {
  await run.start()
  await run.step(
    "CALL-PREP-01",
    "Verify the candidate phone APK, intended glasses and every mandatory firmware target without updating.",
    "The exact fixture is connected and ASG, MTK and fresh BES readback match the pinned manifest.",
    async () => {
      const hardware = await verifyAndroidHardware(rig, true)
      await writeFile(join(run.directory, "hardware-before.json"), JSON.stringify(hardware, null, 2) + "\n")
    },
  )
  await run.step("CALL-PREP-02", "Open Mentra Call's home screen.", "Join a meeting is visible.", async () => {
    const {nodes} = await run.snapshot()
    if (nodes.some((n) => n.id === "subject")) {
      await run.flow("return-from-form", [{assertVisible: "Create & Join"}, {tapOn: "Go back"}])
    } else if (!nodes.some((n) => n.id === "home-link-gate-title")) {
      await run.flow("open-call", [{assertVisible: "Mentra Live"}, {tapOn: "Mentra Call"}])
    }
    await run.flow("call-home", [{assertVisible: "Join a meeting"}])
  })
  await run.step(
    "CALL-PREP-03",
    "Inspect Call settings and the configured video summary.",
    "The direct-link setting and 540p default summary are visible; selected transport still requires native join evidence.",
    async () => {
      await run.flow("settings", [
        {tapOn: "Open settings"},
        {assertVisible: "Direct link for Teams"},
        {assertVisible: "960×540 @ 15 · Auto · 102° bottom"},
      ])
    },
  )
  await run.step(
    "CALL-PREP-04",
    "Open New Call and enter a unique meeting name without creating it.",
    "The form retains the entered name and offers Create & Join.",
    async () => {
      await run.flow("prepare-form", [
        {tapOn: "Go back"},
        {assertVisible: "Join a meeting"},
        {tapOn: "New Call Create a meeting\\."},
        {assertVisible: {id: "subject"}},
        {tapOn: {id: "subject"}},
        {eraseText: 100},
        {inputText: title},
        {hideKeyboard: {}},
        {assertVisible: {id: "subject", text: title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}},
        {assertVisible: "Create & Join"},
      ])
    },
  )
  await run.step(
    "CALL-PREP-05",
    "Cancel the unsubmitted form and return to Call home.",
    "Join a meeting is visible; no meeting or stream was created.",
    async () => {
      await run.flow("cancel-form", [{tapOn: "Go back"}, {assertVisible: "Join a meeting"}])
    },
  )
  status = "passed"
} catch (error) {
  failure = String(error)
  console.error(failure)
  process.exitCode = 1
} finally {
  await run.finish(status, {
    scope: "preparation-only",
    meetingCreated: false,
    callStarted: false,
    otaPerformed: false,
    mediaQualified: false,
    error: failure,
  })
}
