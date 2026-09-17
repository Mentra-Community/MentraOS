import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import test from "node:test"

function notification(scope, overrides = {}) {
  return JSON.parse(
    execFileSync("bash", [new URL("notify-coordinated-release-slack.sh", import.meta.url).pathname], {
      encoding: "utf8",
      env: {
        ...process.env,
        SLACK_NOTIFY_DRY_RUN: "true",
        DEV_SLACK_WEBHOOK_URL: "https://example.invalid",
        BRANCH: "dev",
        REPOSITORY: "Mentra-Community/MentraOS",
        RUN_ID: "123",
        SHA: "a".repeat(40),
        RELEASE_IDENTITY: "3.2.0-dev.265",
        RELEASE_SCOPE: scope,
        FINALIZE_RESULT: "success",
        EXAMPLES_DISPATCH_RESULT: "success",
        ...overrides,
      },
    }),
  )
}

test("core completion is reported without pending example and docs results", () => {
  const payload = notification("core")
  assert.match(payload.blocks[0].text.text, /Dev release complete/)
  const text = JSON.stringify(payload)
  assert.match(text, /View separate workflow/)
  assert.doesNotMatch(text, /Bluetooth example|Example checks|\*.*Docs\*/)
})

test("example notification reports Play failure alongside independently successful docs", () => {
  const payload = notification("examples", {
    FINALIZE_EXAMPLE_RESULT: "skipped",
    DOCS_RESULT: "success",
    DOCS_URL: "https://docs-dev.mentraglass.com",
    EXAMPLE_GOOGLE_PLAY_RESULT: "failure",
  })
  assert.match(payload.blocks[0].text.text, /examples and docs incomplete/)
  const text = JSON.stringify(payload)
  assert.match(text, /Docs\* - passed/)
  assert.match(text, /Google Play: :x: failed/)
  assert.doesNotMatch(text, /Release checks|ASG \+ OTA/)
})

test("dispatch failure stays visible in the core notification", () => {
  assert.match(JSON.stringify(notification("core", {EXAMPLES_DISPATCH_RESULT: "failure"})), /dispatch: :x: failed/)
})
