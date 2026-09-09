import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {
  assertSdkAnalyticsMetadata,
  expectedSdkAnalyticsMetadata,
  INFO_ANALYTICS_DISABLED,
  INFO_ANALYTICS_ENVIRONMENT,
  INFO_SDK_VERSION,
  readIpaInfoPlist,
} from "./release-sdk-metadata.mjs"

const expected = {sdkVersion: "3.1.0", environment: "staging"}

test("expectedSdkAnalyticsMetadata reads the SDK package version and normalizes the lane", () => {
  const value = expectedSdkAnalyticsMetadata({EXPO_PUBLIC_BUILD_ENV: " Prod "})
  assert.match(value.sdkVersion, /^\d+\.\d+\.\d+/)
  assert.equal(value.environment, "prod")
  assert.equal(expectedSdkAnalyticsMetadata({}).environment, undefined)
})

test("assertSdkAnalyticsMetadata accepts a correctly stamped Info.plist", () => {
  assert.doesNotThrow(() =>
    assertSdkAnalyticsMetadata({[INFO_SDK_VERSION]: "3.1.0", [INFO_ANALYTICS_ENVIRONMENT]: "staging"}, expected),
  )
  assert.doesNotThrow(() => assertSdkAnalyticsMetadata({[INFO_SDK_VERSION]: "3.1.0"}, {sdkVersion: "3.1.0"}))
})

test("assertSdkAnalyticsMetadata names every missing or wrong key", () => {
  assert.throws(
    () => assertSdkAnalyticsMetadata({[INFO_ANALYTICS_ENVIRONMENT]: "dev", [INFO_ANALYTICS_DISABLED]: true}, expected),
    (error) => {
      assert.match(error.message, /MentraBluetoothSdkVersion=null \(expected 3\.1\.0\)/)
      assert.match(error.message, /MentraBluetoothSdkAnalyticsEnvironment="dev" \(expected staging\)/)
      assert.match(error.message, /MentraBluetoothSdkAnalyticsDisabled=true/)
      return true
    },
  )
})

test("readIpaInfoPlist decodes the binary Info.plist inside an IPA", {skip: process.platform !== "darwin"}, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ipa-"))
  const appDir = path.join(dir, "Payload", "Mentra.app")
  execFileSync("mkdir", ["-p", appDir])
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>${INFO_SDK_VERSION}</key><string>3.1.0</string>
<key>${INFO_ANALYTICS_ENVIRONMENT}</key><string>staging</string>
</dict></plist>
`
  writeFileSync(path.join(appDir, "Info.plist"), xml)
  execFileSync("plutil", ["-convert", "binary1", path.join(appDir, "Info.plist")])
  const ipaPath = path.join(dir, "Mentra.ipa")
  execFileSync("zip", ["-qr", ipaPath, "Payload"], {cwd: dir})

  const infoPlist = readIpaInfoPlist(ipaPath)
  assert.equal(infoPlist[INFO_SDK_VERSION], "3.1.0")
  assert.doesNotThrow(() => assertSdkAnalyticsMetadata(infoPlist, expected))
})
