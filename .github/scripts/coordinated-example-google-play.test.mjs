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
  const starterKit = {
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    channel,
    mentraos: {sourceCommit: plan.sourceCommit},
    starterKit: {baseCommit: "b".repeat(40), releaseCommit: "c".repeat(40)},
    packages: {"@mentra/bluetooth-sdk": plan.releaseIdentity, "@mentra/engine": plan.releaseIdentity},
  }
  const track = channel === "dev" ? "internal" : "beta"
  return {plan, starterKit, track}
}

for (const channel of ["dev", "beta"]) {
  test(`${channel} preserves coordinated identity and the correct audience`, () => {
    const input = fixture(channel)
    const coordinates = examplePlayCoordinates(input.plan, input.starterKit, input.track)
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
    assert.equal(record.starterKitReleaseCommit, input.starterKit.starterKit.releaseCommit)
    for (const mutation of [
      {track: channel === "dev" ? "beta" : "internal"},
      {packageId: "com.mentra.mentra"},
      {version: {...record.version, buildNumber: 1}},
      {starterKitReleaseCommit: "d".repeat(40)},
      {aab: {...record.aab, sha256: "invalid"}},
      {distribution: {...record.distribution, status: "available"}},
    ])
      assert.throws(() => validateExampleGooglePlay(input.plan, input.starterKit, {...record, ...mutation}))
  })
}

test("rejects incorrect channels, source revisions, packages, and absent Play version codes", () => {
  const {plan, starterKit, track} = fixture()
  assert.throws(() => examplePlayCoordinates(plan, starterKit, "production"), /track/)
  assert.throws(() => examplePlayCoordinates({...plan, channel: "production"}, starterKit, "internal"), /track/)
  assert.throws(() => examplePlayCoordinates(plan, {...starterKit, packages: {}}, track), /source/)
  assert.throws(
    () =>
      examplePlayCoordinates(
        plan,
        {...starterKit, starterKit: {...starterKit.starterKit, baseCommit: "not-a-commit"}},
        track,
      ),
    /source/,
  )
  assert.throws(() => createExampleGooglePlayRecord({plan, starterKit, track, codes: [1]}), /exact coordinated version/)
  assert.throws(() => validateExampleGooglePlay(plan, starterKit, undefined))
})

test("configures only Android store identity without changing iOS or dependencies", () => {
  const {plan, starterKit} = fixture()
  const config = {
    expo: {
      name: "Example",
      ios: {bundleIdentifier: "original"},
      android: {package: "original", permissions: ["CAMERA"]},
    },
  }
  const result = configureExampleAndroid(plan, config, {dependencies: starterKit.packages})
  assert.equal(result.expo.android.package, "com.mentra.bluetoothsdkexample")
  assert.equal(result.expo.android.versionCode, plan.native.buildNumber)
  assert.equal(result.expo.version, "3.1.0")
  assert.deepEqual(result.expo.ios, config.expo.ios)
  assert.deepEqual(result.expo.android.permissions, ["CAMERA"])
  assert.equal(config.expo.android.package, "original")
  assert.throws(() => configureExampleAndroid(plan, config, {dependencies: {}}), /must match/)
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

test("coordinator selects MentraOS tracks from policy and separates example audiences", () => {
  const workflow = readFileSync(new URL("../workflows/coordinated-release.yml", import.meta.url), "utf8")
  const channelBlock = workflow.slice(workflow.indexOf('case "$BRANCH"'), workflow.indexOf("Restore the release plan"))
  const devBlock = channelBlock.slice(channelBlock.indexOf("dev)"), channelBlock.indexOf("staging)"))
  const stagingBlock = channelBlock.slice(channelBlock.indexOf("staging)"))
  assert.match(devBlock, /native-build-policy\.json.*play\.dev/)
  assert.match(stagingBlock, /echo "play_track=beta"/)
  assert.doesNotMatch(devBlock, /echo "play_track=beta"/)
  assert.doesNotMatch(stagingBlock, /echo "play_track=internal"/)
  assert.match(channelBlock, /example_play_track=internal/)
  assert.match(channelBlock, /example_play_track=beta/)
  assert.match(workflow, /needs\.example-google-play\.result == 'success'/)
  assert.match(workflow, /--example-google-play release-input\/example-google-play/)
  const reusable = readFileSync(
    new URL("../workflows/reusable-coordinated-example-google-play.yml", import.meta.url),
    "utf8",
  )
  assert.ok(reusable.indexOf("persist exact signed bytes") < reusable.indexOf("Upload exact App Bundle"))
  assert.match(reusable, /starter_release_commit/)
  assert.match(reusable, /cancel-in-progress: false/)
  assert.match(reusable, /queue: max/)
  assert.ok(
    reusable.indexOf(".mjs verify-aab") < reusable.indexOf("node .github/scripts/publish-immutable-release-asset.mjs"),
  )
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
