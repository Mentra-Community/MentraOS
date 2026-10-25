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
        ...overrides,
        TEST_RUN_INGEST_TOKEN: "",
        TEST_RUN_INGEST_TOKEN_DEV: "",
      },
    }),
  )
}

test("one release message reports the release, the examples and the docs", (t) => {
  const bin = mkdtempSync(path.join(tmpdir(), "notification-http-"))
  t.after(() => rmSync(bin, {recursive: true, force: true}))
  writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nexit 0\n", {mode: 0o755})
  const payload = notification("core", {
    PATH: `${bin}:${process.env.PATH}`,
    EXAMPLES_RESULT: "success",
    EXAMPLE_APK_URL: "https://artifactscdn.mentraglass.com/x/mentra-example-react-native-3.2.0-dev.265.apk",
    EXAMPLE_TESTFLIGHT_RESULT: "success",
    EXAMPLE_TESTFLIGHT_INSTALL_URL: "https://testflight.apple.com/join/abc",
    EXAMPLE_GOOGLE_PLAY_RESULT: "failure",
    DOCS_RESULT: "success",
    DOCS_URL: "https://docs-dev.mentraglass.com",
  })
  // An example or Play failure never makes the Mentra release incomplete.
  assert.match(payload.blocks[0].text.text, /Dev release complete/)
  const text = JSON.stringify(payload)
  assert.match(text, /Bluetooth examples and docs/)
  assert.match(text, /Example builds: :white_check_mark: passed - <https:\/\/artifactscdn[^|]+\|React Native example APK>/)
  assert.match(text, /TestFlight: :white_check_mark: passed - <https:\/\/testflight\.apple\.com\/join\/abc\|Open TestFlight>/)
  assert.match(text, /Google Play: :x: failed/)
  assert.match(text, /Docs: :white_check_mark: passed - <https:\/\/docs-dev\.mentraglass\.com\|Open docs>/)
  assert.match(text, /Routine results for published app builds/)
  assert.match(text, /current Harness routine source inventory is unavailable/)
  assert.doesNotMatch(text, /No-glasses UI|Requested tests|reported separately|Starter Kit|Example finalize/)
  assert.match(text, /Request pipeline/)
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
})


test("store phase failures remain visible even when downloadable artifacts are ready", () => {
  const payload = notification("core", {IOS_RESULT: "failure", ANDROID_RESULT: "failure", FINALIZE_RESULT: "failure"})
  const text = JSON.stringify(payload)
  assert.match(text, /iOS: :x: failed · TestFlight:/)
  assert.match(text, /Android: :x: failed · Google Play:/)
})

test("app lines show the build numbers Google Play Console and App Store Connect show", () => {
  const text = JSON.stringify(
    notification("core", {
      BRANCH: "staging",
      STAGING_SLACK_WEBHOOK_URL: "https://example.invalid",
      ANDROID_RESULT: "success",
      IOS_RESULT: "success",
      ANDROID_VERSION_CODE: "304000123",
      IOS_BUILD_NUMBER: "304000120",
    }),
  )
  assert.match(text, /Google Play: [^\\]*· versionCode 304000123/)
  assert.match(text, /TestFlight: [^\\]*· build 304000120/)
})
