import {execFileSync} from "node:child_process"
import {writeFile} from "node:fs/promises"
import {parseArgs} from "node:util"
import {verifyAndroidFixture} from "./runner/android-fixture"

try {
  const {values} = parseArgs({
    args: process.argv.slice(2),
    options: {serial: {type: "string"}, glasses: {type: "string"}, output: {type: "string"}},
  })
  if (!values.serial || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(values.serial) || !values.glasses)
    throw new Error(
      "Usage: bun tools/mentra-e2e/android-preflight.ts --serial <ADB serial> --glasses Mentra_Live_XXXX [--output <new JSON file>]",
    )
  const adb = (...args: string[]) =>
    execFileSync("adb", ["-s", values.serial!, ...args], {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    })
  if (adb("get-state").trim() !== "device") throw new Error("The selected ADB device is not available")
  const result = {
    checkedAt: new Date().toISOString(),
    serial: values.serial,
    ...verifyAndroidFixture(adb("shell", "dumpsys", "bluetooth_manager"), values.glasses),
  }
  const json = JSON.stringify(result, null, 2) + "\n"
  // An existing file is evidence, never a target for a silently overwritten check.
  if (values.output) await writeFile(values.output, json, {flag: "wx"})
  console.log(json)
  if (!result.passed) process.exitCode = 2
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
}
