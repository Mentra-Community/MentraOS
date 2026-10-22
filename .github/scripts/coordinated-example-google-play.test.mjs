import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import test from "node:test"
import {
  configureExampleAndroid,
  createExampleGooglePlayRecord,
  examplePlayCoordinates,
  validateExampleGooglePlay,
  verifyExampleAabIdentity,
} from "./coordinated-example-google-play.mjs"

function fixture(channel = "beta") {
  const plan = {
    channel,
    releaseIdentity: `3.1.0-${channel}.42`,
    releaseSetId: `mentra-3.1.0-${channel}.42`,
    sourceCommit: "a".repeat(40),
    native: {marketingVersion: "3.1.0", buildNumber: 310000042},
    artifactContainerTag: "mentra-builds-v3.1.0",
  }
  const track = channel === "dev" ? "internal" : "beta"
  return {plan, track}
}

for (const channel of ["dev", "beta"]) {
  test(`${channel} preserves coordinated identity and the correct audience`, () => {
    const input = fixture(channel)
    const coordinates = examplePlayCoordinates(input.plan, input.track)
    const record = createExampleGooglePlayRecord({
      ...input,
      codes: [String(input.plan.native.buildNumber)],
      aab: Buffer.from("bundle"),
      artifactUrl: coordinates.aab_url,
      uploadStatus: "published",
      provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/123",
    })
    assert.equal(record.distribution.audience, channel === "dev" ? "internal" : "external")
    assert.equal(record.distribution.status, "submitted")
    assert.equal(record.aab.size, 6)
    assert.equal(record.schemaVersion, 2)
    assert.equal(record.mentraosSourceCommit, input.plan.sourceCommit)
    for (const mutation of [
      {track: channel === "dev" ? "beta" : "internal"},
      {packageId: "com.mentra.mentra"},
      {version: {...record.version, buildNumber: 1}},
      {mentraosSourceCommit: "d".repeat(40)},
      {schemaVersion: 1},
      {aab: {...record.aab, sha256: "invalid"}},
      {distribution: {...record.distribution, status: "available"}},
    ])
      assert.throws(() => validateExampleGooglePlay(input.plan, {...record, ...mutation}))
  })
}

test("rejects incorrect channels, source revisions, and absent Play version codes", () => {
  const {plan, track} = fixture()
  assert.throws(() => examplePlayCoordinates(plan, "production"), /track/)
  assert.throws(() => examplePlayCoordinates({...plan, channel: "production"}, "internal"), /track/)
  assert.throws(() => examplePlayCoordinates({...plan, sourceCommit: "not-a-commit"}, track), /release plan/)
  assert.throws(() => examplePlayCoordinates({...plan, releaseSetId: "mentra-3.1.0-beta.41"}, track), /release plan/)
  assert.throws(() => createExampleGooglePlayRecord({plan, track, codes: [1]}), /exact coordinated version/)
  assert.throws(() => validateExampleGooglePlay(plan, undefined))
})

test("configures only Android store identity without changing iOS", () => {
  const {plan} = fixture()
  const config = {
    expo: {
      name: "Example",
      ios: {bundleIdentifier: "original"},
      android: {package: "original", permissions: ["CAMERA"]},
    },
  }
  const result = configureExampleAndroid(plan, config)
  assert.equal(result.expo.android.package, "com.mentra.bluetoothsdkexample")
  assert.equal(result.expo.android.versionCode, plan.native.buildNumber)
  assert.equal(result.expo.version, "3.1.0")
  assert.deepEqual(result.expo.ios, config.expo.ios)
  assert.deepEqual(result.expo.android.permissions, ["CAMERA"])
  assert.equal(config.expo.android.package, "original")
  assert.throws(() => configureExampleAndroid({...plan, channel: "nightly"}, config), /Only coordinated/)
})

test("verifies package and both native versions from the actual bundle", () => {
  const {plan} = fixture()
  const attributes = {
    "package": "com.mentra.bluetoothsdkexample",
    "android:versionCode": String(plan.native.buildNumber),
    "android:versionName": plan.native.marketingVersion,
  }
  const readAttribute = (values) => (command, args, options) => {
    assert.equal(command, "java")
    assert.deepEqual(args.slice(0, 6), [
      "-jar",
      "/tools/bundletool.jar",
      "dump",
      "manifest",
      "--bundle=/release/example.aab",
      "--module=base",
    ])
    assert.equal(options.encoding, "utf8")
    return `${values[args[6].replace("--xpath=/manifest/@", "")]}\n`
  }
  const verify = (values) =>
    verifyExampleAabIdentity(plan, "/release/example.aab", "/tools/bundletool.jar", readAttribute(values))
  assert.doesNotThrow(() => verify(attributes))
  for (const attribute of Object.keys(attributes)) {
    assert.throws(() => verify({...attributes, [attribute]: "wrong"}), /does not match/)
    assert.throws(() => verify({...attributes, [attribute]: ""}), /does not match/)
  }
  assert.throws(
    () =>
      verifyExampleAabIdentity(plan, "bundle.aab", "bundletool.jar", () => {
        throw new Error("Cannot decode bundle")
      }),
    /Cannot decode bundle/,
  )
})

test("coordinator preserves MentraOS tracks and separates example audiences", () => {
  const workflow = readFileSync(new URL("../workflows/coordinated-release.yml", import.meta.url), "utf8")
  const channelBlock = workflow.slice(workflow.indexOf('case "$BRANCH"'), workflow.indexOf("Restore the release plan"))
  const devBlock = channelBlock.slice(channelBlock.indexOf("dev)"), channelBlock.indexOf("staging)"))
  const stagingBlock = channelBlock.slice(channelBlock.indexOf("staging)"))
  assert.match(devBlock, /echo "play_track=internal"/)
  assert.match(stagingBlock, /echo "play_track=beta"/)
  assert.doesNotMatch(devBlock, /echo "play_track=beta"/)
  assert.doesNotMatch(stagingBlock, /echo "play_track=internal"/)
  assert.match(workflow, /^    needs: \[plan, publish-examples, example-testflight, example-google-play\]$/m)
  assert.match(workflow, /--example-google-play release-input\/example-google-play/)
  const reusable = readFileSync(
    new URL("../workflows/reusable-coordinated-example-google-play.yml", import.meta.url),
    "utf8",
  )
  assert.ok(reusable.indexOf("persist exact signed bytes") < reusable.indexOf("Upload exact App Bundle"))
  // The store build is the example at the release source, stamped like the app.
  assert.doesNotMatch(reusable, /starter|Starter Kit/i)
  assert.match(reusable, /working-directory: examples\/bluetooth\/react-native\n/)
  assert.match(reusable, /write-release-metadata\.mjs/)
  assert.match(reusable, /cancel-in-progress: false/)
  assert.match(reusable, /queue: max/)
  assert.ok(reusable.indexOf(".mjs verify-aab") < reusable.indexOf("publish-immutable-release-asset.mjs"))
  const verificationStep = reusable.slice(
    reusable.indexOf("- name: Verify and persist"),
    reusable.indexOf("- name: Require Play access"),
  )
  assert.doesNotMatch(verificationStep, /if:.*existing/)
  assert.doesNotMatch(reusable, /-PreactNativeArchitectures=/)
  assert.match(reusable, /arm64-v8a,x86_64/)
  assert.doesNotMatch(reusable, /track_promote|GOOGLE_PLAY_TRACK: production/)
  const notification = readFileSync(new URL("notify-coordinated-release-slack.sh", import.meta.url), "utf8")
  assert.match(notification, /checks_line\+=" \| Example Google Play:/)
})

test("the production example has its own closed Play track for an internal audience", () => {
  const {plan: beta} = fixture()
  const plan = {
    ...beta,
    channel: "production",
    releaseIdentity: "3.1.0",
    releaseSetId: "mentra-3.1.0",
    artifactContainerTag: "mentra-v3.1.0",
    native: {marketingVersion: "3.1.0", buildNumber: 310000099},
  }
  const coordinates = examplePlayCoordinates(plan, "Mentra Bluetooth Example Production Candidates")
  assert.equal(coordinates.build_number, 310000099)
  assert.equal(coordinates.aab_name, "mentra-example-react-native-3.1.0.aab")
  assert.match(coordinates.aab_url, /mentra-v3\.1\.0\/mentra-example-react-native-3\.1\.0\.aab$/)
  assert.throws(() => examplePlayCoordinates(plan, "internal"), /track/)
  assert.throws(() => examplePlayCoordinates(plan, "beta"), /track/)
  const config = configureExampleAndroid(plan, {expo: {ios: {bundleIdentifier: "x"}, android: {}}})
  assert.equal(config.expo.android.versionCode, 310000099)
  assert.equal(config.expo.version, "3.1.0")
  const record = createExampleGooglePlayRecord({
    plan,
    track: "Mentra Bluetooth Example Production Candidates",
    codes: [310000099],
    aab: Buffer.from("aab"),
    artifactUrl: coordinates.aab_url,
    uploadStatus: "published",
    provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/1",
  })
  assert.equal(record.distribution.audience, "internal")
  assert.equal(record.track, "Mentra Bluetooth Example Production Candidates")
})
