import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {
  assertAndroidSdkAnalyticsMetadata,
  assertSdkAnalyticsMetadata,
  expectedSdkAnalyticsMetadata,
  findAapt2,
  INFO_ANALYTICS_DISABLED,
  INFO_ANALYTICS_ENVIRONMENT,
  INFO_SDK_VERSION,
  META_ANALYTICS_DISABLED,
  META_ANALYTICS_ENVIRONMENT,
  parseManifestMetaData,
  readApkManifestMetaData,
  readIpaInfoPlist,
} from "./release-sdk-metadata.mjs"

const expected = {sdkVersion: "3.1.0", environment: "staging"}

test("expectedSdkAnalyticsMetadata reads the SDK package version and requires a normalized lane", () => {
  const value = expectedSdkAnalyticsMetadata({EXPO_PUBLIC_BUILD_ENV: " Prod "})
  assert.match(value.sdkVersion, /^\d+\.\d+\.\d+/)
  assert.equal(value.environment, "prod")
  assert.throws(() => expectedSdkAnalyticsMetadata({}), /EXPO_PUBLIC_BUILD_ENV is not set/)
})

test("assertSdkAnalyticsMetadata accepts a correctly stamped Info.plist", () => {
  assert.doesNotThrow(() =>
    assertSdkAnalyticsMetadata({[INFO_SDK_VERSION]: "3.1.0", [INFO_ANALYTICS_ENVIRONMENT]: "staging"}, expected),
  )
  assert.throws(
    () => assertSdkAnalyticsMetadata({[INFO_SDK_VERSION]: "3.1.0"}, expected),
    /MentraBluetoothSdkAnalyticsEnvironment=null/,
  )
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

const XMLTREE_SAMPLE = `N: android=http://schemas.android.com/apk/res/android
  E: manifest (line=2)
    E: application (line=10)
      E: meta-data (line=20)
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="com.mapbox.token" (Raw: "com.mapbox.token")
        A: http://schemas.android.com/apk/res/android:value(0x01010024)="pk.abc" (Raw: "pk.abc")
      E: meta-data (line=24)
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="${META_ANALYTICS_ENVIRONMENT}" (Raw: "${META_ANALYTICS_ENVIRONMENT}")
        A: http://schemas.android.com/apk/res/android:value(0x01010024)="staging" (Raw: "staging")
      E: meta-data (line=28)
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="${META_ANALYTICS_DISABLED}" (Raw: "${META_ANALYTICS_DISABLED}")
        A: http://schemas.android.com/apk/res/android:value(0x01010024)="true" (Raw: "true")
      E: service (line=40)
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="com.mentra.bluetoothsdk.services.ForegroundService"
`

test("parseManifestMetaData reads meta-data name/value pairs out of aapt2 xmltree output", () => {
  const meta = parseManifestMetaData(XMLTREE_SAMPLE)
  assert.deepEqual(meta, {
    "com.mapbox.token": "pk.abc",
    [META_ANALYTICS_ENVIRONMENT]: "staging",
    [META_ANALYTICS_DISABLED]: "true",
  })
})

test("assertAndroidSdkAnalyticsMetadata rejects disabled analytics or a wrong lane, accepts a correct manifest", () => {
  assert.throws(
    () =>
      assertAndroidSdkAnalyticsMetadata(parseManifestMetaData(XMLTREE_SAMPLE), {
        sdkVersion: "3.1.0",
        environment: "prod",
      }),
    (error) => {
      assert.match(error.message, /analytics\.disabled="true"/)
      assert.match(error.message, /analytics\.environment="staging" \(expected prod\)/)
      return true
    },
  )
  assert.throws(
    () => assertAndroidSdkAnalyticsMetadata({}, {sdkVersion: "3.1.0", environment: "prod"}),
    /analytics\.environment=null/,
  )
  assert.doesNotThrow(() =>
    assertAndroidSdkAnalyticsMetadata(
      {[META_ANALYTICS_ENVIRONMENT]: "prod"},
      {sdkVersion: "3.1.0", environment: "prod"},
    ),
  )
  assert.doesNotThrow(() =>
    assertAndroidSdkAnalyticsMetadata(
      {[META_ANALYTICS_ENVIRONMENT]: "prod", [META_ANALYTICS_DISABLED]: "false"},
      {sdkVersion: "3.1.0", environment: "prod"},
    ),
  )
})

test(
  "readApkManifestMetaData reads a real APK when aapt2 is available",
  {skip: !findAapt2() || !process.env.MENTRA_TEST_APK},
  () => {
    const meta = readApkManifestMetaData(process.env.MENTRA_TEST_APK)
    assert.ok(META_ANALYTICS_ENVIRONMENT in meta, "the Mentra App manifest carries the analytics lane")
  },
)

const BARE_BOOLEAN_SAMPLE = `N: android=http://schemas.android.com/apk/res/android
  E: manifest (line=2)
    E: application (line=10)
      E: meta-data (line=24)
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="${META_ANALYTICS_ENVIRONMENT}" (Raw: "${META_ANALYTICS_ENVIRONMENT}")
        A: http://schemas.android.com/apk/res/android:value(0x01010024)="prod" (Raw: "prod")
      E: meta-data (line=28)
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="${META_ANALYTICS_DISABLED}" (Raw: "${META_ANALYTICS_DISABLED}")
        A: http://schemas.android.com/apk/res/android:value(0x01010024)=true
      E: meta-data (line=32)
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="legacy.typed" (Raw: "legacy.typed")
        A: http://schemas.android.com/apk/res/android:value(0x01010024)=(type 0x12)0xffffffff
      E: meta-data (line=36)
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="legacy.typed.false" (Raw: "legacy.typed.false")
        A: http://schemas.android.com/apk/res/android:value(0x01010024)=(type 0x12)0x0
`

test("a bare aapt2 boolean, the build-tools 36 form, is parsed and rejects disabled analytics even with a correct lane", () => {
  const meta = parseManifestMetaData(BARE_BOOLEAN_SAMPLE)
  assert.equal(meta[META_ANALYTICS_DISABLED], "true")
  assert.equal(meta[META_ANALYTICS_ENVIRONMENT], "prod")
  assert.equal(meta["legacy.typed"], "true")
  assert.equal(meta["legacy.typed.false"], "false")
  assert.throws(
    () => assertAndroidSdkAnalyticsMetadata(meta, {sdkVersion: "3.1.0", environment: "prod"}),
    /analytics\.disabled="true"/,
  )
})

test("an unrecognized value on the disabled key fails rather than reading as enabled", () => {
  for (const bad of ["", "@0x7f010000", "yes"]) {
    assert.throws(
      () =>
        assertAndroidSdkAnalyticsMetadata(
          {[META_ANALYTICS_ENVIRONMENT]: "prod", [META_ANALYTICS_DISABLED]: bad},
          {sdkVersion: "3.1.0", environment: "prod"},
        ),
      /analytics\.disabled=/,
    )
  }
})
