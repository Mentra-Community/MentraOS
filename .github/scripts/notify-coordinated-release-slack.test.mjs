import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {mkdtempSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
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
  assert.match(text, /Requested tests/)
  assert.match(text, /No-glasses UI/)
  assert.match(text, /Request pipeline/)
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
  assert.doesNotMatch(text, /Requested tests/)
})

test("dispatch failure stays visible in the core notification", () => {
  assert.match(JSON.stringify(notification("core", {EXAMPLES_DISPATCH_RESULT: "failure"})), /dispatch: :x: failed/)
})

test("page publication failure preserves core success and links the artifact container", () => {
  const payload = notification("core", {RELEASE_PAGE_RESULT: "failure"})
  assert.match(payload.blocks[0].text.text, /Dev release complete/)
  const text = JSON.stringify(payload)
  assert.match(text, /Download page: :x: failed/)
  assert.match(text, /releases\/tag\/mentra-builds-v3\.2\.0/)
})

test("mobile links can mix a historical GitHub APK and a new CDN IPA", (t) => {
  const bin = mkdtempSync(path.join(tmpdir(), "notification-http-"))
  t.after(() => rmSync(bin, {recursive: true, force: true}))
  writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nexit 0\n", {mode: 0o755})
  const apk = "https://github.com/Mentra-Community/MentraOS/releases/download/v1/app.apk"
  const ipa = "https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/v1/app.ipa"
  const text = JSON.stringify(
    notification("core", {
      PATH: `${bin}:${process.env.PATH}`,
      MOBILE_APK_URL: apk,
      MOBILE_IPA_URL: ipa,
      APK_NAME: "app.apk",
      IPA_NAME: "app.ipa",
    }),
  )
  assert.ok(text.includes(apk))
  assert.ok(text.includes(ipa))
  const examples = JSON.stringify(
    notification("examples", {
      PATH: `${bin}:${process.env.PATH}`,
      MOBILE_APK_URL: apk,
      MOBILE_IPA_URL: ipa,
      APK_NAME: "app.apk",
      IPA_NAME: "app.ipa",
      EXAMPLE_GOOGLE_PLAY_RESULT: "failure",
    }),
  )
  assert.ok(examples.includes("Mentra App downloads"))
  assert.ok(examples.includes(apk))
  assert.ok(examples.includes(ipa))
  assert.match(examples, /Google Play: :x: failed/)
})


test("store phase failures remain visible even when downloadable artifacts are ready", () => {
  const payload = notification("core", {IOS_RESULT: "failure", ANDROID_RESULT: "failure", FINALIZE_RESULT: "failure"})
  const text = JSON.stringify(payload)
  assert.match(text, /iOS: :x: failed · TestFlight:/)
  assert.match(text, /Android: :x: failed · Google Play:/)
})
