import {beforeAll, expect, test} from "bun:test"
import {buildDriver, command, type Command} from "./driver"
import {redact} from "./report"

// Read-only checks against the real helper. Never activate or type into the app.
// Opt in on a provisioned Mac; ordinary unit tests need no running UI.
const nativeTest = process.env.MENTRA_E2E_NATIVE_CHECKS === "1" ? test : test.skip
beforeAll(async () => {
  if (process.env.MENTRA_E2E_NATIVE_CHECKS === "1") await buildDriver()
}, 30000)

nativeTest.each([
  {op: "focus"},
  {op: "key", key: "return", allowForeground: true},
  {op: "press", method: "mouse", selector: {description: "Give Feedback"}},
  {op: "press", selector: {region: {x: 0, y: 0, width: 100, height: 100}}},
  {op: "press", selector: {role: "AXGenericElement", description: ""}},
  {op: "perform", action: "AXRaise", selector: {description: "Mentra"}},
])("reject unsupported input %j", async (input) => {
  await expect(command(input as Command)).rejects.toThrow(
    /Unsupported|unsupported|required|Only accessibility|Unknown operation/,
  )
})

nativeTest("missing named target fails instead of guessing another element", async () => {
  await expect(command({op: "press", selector: {identifier: "mentra.e2e.nonexistent"}})).rejects.toThrow(
    "matched 0 elements",
  )
})

test("redact secrets embedded in nested failure messages and snapshots", () => {
  const secret = "synthetic-test-secret"
  const data = {error: `Rejected: ${secret}`, snapshot: [{value: secret}], empty: ""}
  expect(redact(data, ["", secret])).toEqual({
    error: "Rejected: [REDACTED]",
    snapshot: [{value: "[REDACTED]"}],
    empty: "",
  })
  expect(data.snapshot[0].value).toBe(secret)
})
