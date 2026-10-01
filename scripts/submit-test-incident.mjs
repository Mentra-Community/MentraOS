#!/usr/bin/env bun
// Both platforms use the same app handler; Android's old broadcast remains compatible.
import {spawnSync} from "node:child_process"
const [target, ...args] = process.argv.slice(2)
const serial = target === "--android" ? args.shift() : undefined
if (!["--mac", "--android"].includes(target) || (target === "--android" && !serial) || !args.length) {
  console.error("Usage: bun scripts/submit-test-incident.mjs --mac | --android <phone-serial> key=value ...")
  process.exit(1)
}
const query = new URLSearchParams()
for (const argument of args) {
  const equals = argument.indexOf("=")
  if (equals < 1) throw new Error("Incident fields must use key=value")
  const key = argument.slice(0, equals)
  if (query.has(key)) throw new Error(`Duplicate incident field: ${key}`)
  query.set(key, argument.slice(equals + 1))
}
const url = `com.mentra://test/submit-incident-report?${query}`
const result =
  target === "--mac"
    ? spawnSync("open", [url], {stdio: "inherit"})
    : spawnSync(
        "adb",
        [
          "-s",
          serial,
          "shell",
          "am",
          "start",
          "-a",
          "android.intent.action.VIEW",
          "-d",
          `'${url}'`,
          "-p",
          "com.mentra.mentra",
        ],
        {stdio: "inherit"},
      )
if (result.status !== 0) throw new Error("Failed to deliver incident request")
console.log(
  "Incident request delivered. The Mentra App shows submission status and the uploaded report ID; delivery alone is not upload success.",
)
