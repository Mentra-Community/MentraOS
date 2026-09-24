import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"
import {downloadNames, prepareDownloads, publishDownloads, restoreDownloads, validateDownloads} from "./coordinated-install-downloads.mjs"
import {platformDownloads, otaTargetText, coordinatedRoutineLinks} from "./coordinated-downloads-slack.mjs"
import {coordinatedFixture} from "./coordinated-routine-fixture.mjs"
import {createIosRecord} from "./coordinated-mobile-records.mjs"

const repository = "Mentra-Community/MentraOS"
const ota = "https://artifactscdn.mentraglass.com/release.json"
function fixture(t, channel = "dev") {
  const directory = mkdtempSync(path.join(tmpdir(), "coordinated-downloads-test-"))
  t.after(() => rmSync(directory, {recursive: true, force: true}))
  const identity = `3.2.1-${channel}.57`
  const plan = {
    channel,
    sourceCommit: "a".repeat(40),
    releaseIdentity: identity,
    releaseSetId: `mentra-${identity}`,
    familyBaseVersion: "3.2.1",
    artifactContainerTag: "mentra-builds-v3.2.1",
    members: {mentraos: {version: identity}},
    native: {buildNumber: 302010057, marketingVersion: "3.2.1"},
    artifactNames: {iosApp: `mentraos-${identity}-ios.ipa`},
  }
  const names = downloadNames(plan)
  const receipt = {
    schemaVersion: 1,
    releaseIdentity: identity,
    sourceCommit: plan.sourceCommit,
    app: {
      bundleId: "com.mentra.mentra",
      build: "302010057",
      version: "3.2.1",
      headSha: plan.sourceCommit,
      backend: channel === "dev" ? "dev" : "staging",
      otaManifestUrl: ota,
      executableSha256: "e".repeat(64),
      javascriptSha256: "f".repeat(64),
    },
    artifacts: {},
  }
  for (const kind of ["iphone", "mac"]) {
    const bytes = `${kind} signed bytes`
    writeFileSync(path.join(directory, names[kind]), bytes)
    receipt.artifacts[kind] = {
      name: names[kind],
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }
  }
  writeFileSync(path.join(directory, names.receipt), JSON.stringify(receipt))
  return {plan, directory, receipt, names}
}
for (const channel of ["dev", "beta"])
  test(`${channel} installation page targets the exact ad hoc IPA and backend`, (t) => {
    const {plan, directory, names} = fixture(t, channel)
    prepareDownloads(directory, plan, repository, ota)
    const plist = readFileSync(path.join(directory, names.manifest), "utf8")
    const page = readFileSync(path.join(directory, names.install), "utf8")
    assert.ok(plist.includes(names.iphone))
    assert.ok(page.includes(encodeURIComponent(names.manifest)))
    assert.match(page, new RegExp(`${channel === "dev" ? "dev" : "staging"} backend`))
    assert.doesNotMatch(page, /PR #|7 days/)
  })
test("publishes verified original bytes before the receipt and preserves them on retry", (t) => {
  const {plan, directory, names} = fixture(t)
  const calls = []
  const exec = (command, args) => calls.push(args[args.indexOf("--name") + 1])
  publishDownloads(directory, plan, repository, ota, "123", {exec})
  assert.equal(calls.at(-1), names.receipt)
  assert.equal(calls.length, 5)
  const before = readFileSync(path.join(directory, names.receipt))
  publishDownloads(directory, plan, repository, ota, "123", {exec})
  assert.deepEqual(readFileSync(path.join(directory, names.receipt)), before)
  writeFileSync(path.join(directory, names.mac), "corrupt bytes")
  assert.throws(() => publishDownloads(directory, plan, repository, ota, "123", {exec}), /bytes disagree/)
  assert.equal(calls.length, 10, "corruption must prevent all uploads")
})
test("rejects stale source, release, native version, backend, OTA and partial download sets", (t) => {
  const {plan, directory} = fixture(t)
  const receipt = prepareDownloads(directory, plan, repository, ota)
  for (const change of [
    {sourceCommit: "b".repeat(40)},
    {releaseIdentity: "3.2.1-dev.58"},
    {app: {...receipt.app, build: "302010058"}},
    {app: {...receipt.app, backend: "staging"}},
    {app: {...receipt.app, otaManifestUrl: "https://other.example/ota"}},
    {artifacts: {iphone: receipt.artifacts.iphone}},
  ]) {
    assert.throws(() => validateDownloads({...receipt, ...change}, plan, ota))
  }
  assert.throws(() => downloadNames({...plan, releaseIdentity: "3.2.1"}), /dev or beta/)
})
test("iOS result keeps TestFlight evidence and adds verified downloads for finalization", (t) => {
  const {plan, directory, names} = fixture(t)
  prepareDownloads(directory, plan, repository, ota)
  const record = createIosRecord({
    plan,
    ipa: path.join(directory, names.iphone),
    ipaUrl: "https://example.com/store.ipa",
    testflightGroup: "Mentra Dev",
    storeStatus: "built",
    provenanceUrl: "https://example.com/run",
    downloads: directory,
    otaUrl: ota,
    repository,
  })
  assert.equal(record.artifacts.length, 5)
  assert.equal(record.publications.mentraos["app-store-connect"].status, "built")
  assert.ok(record.artifacts.some((entry) => entry.coordinate === names.install))
})
test("Slack uses symmetric rows, direct iPhone and share links; incomplete Apple downloads stay unavailable", () => {
  const env = {
    BRANCH: "staging",
    MOBILE_APK_URL: "https://example.com/a.apk",
    IPHONE_MANIFEST_URL: "https://example.com/i.plist",
    IPHONE_SHARE_URL: "https://example.com/i.html",
    MAC_URL: "https://example.com/m.zip",
  }
  const blocks = platformDownloads(env, (url) => Boolean(url))
  assert.equal(blocks[0].elements.length, 3)
  const iphone = blocks[0].elements[1].elements.filter((entry) => entry.type === "link")
  assert.equal(iphone[0].text, "Install on iPhone")
  assert.ok(iphone[0].url.startsWith("itms-services://"))
  assert.equal(iphone[1].text, "Share install link")
  assert.doesNotMatch(JSON.stringify(blocks), /Download IPA/)
  const failed = platformDownloads(env, (url) => url !== env.MAC_URL)
  assert.match(JSON.stringify(failed), /Download APK/)
  assert.doesNotMatch(JSON.stringify(failed), /Install on iPhone/)
})
test("Slack firmware targets must belong to the current release", () => {
  const manifest = {
    releaseVersion: "3.2.1-dev.57",
    apps: {"com.mentra.asg_client": {versionName: "3.2.1", versionCode: 302010057}},
    bes_firmware: {version: "26.9.21.1"},
    mtk_full_ota: {end_firmware: "MentraLive_20260915.0"},
  }
  assert.match(otaTargetText(manifest, manifest.releaseVersion), /302010057/)
  assert.throws(() => otaTargetText(manifest, "3.2.1-dev.58"), /do not match/)
})

test("restore accepts only a complete matching published receipt and its original bytes", async (t) => {
  const {plan, directory, names} = fixture(t)
  prepareDownloads(directory, plan, repository, ota)
  const bytes = new Map(Object.values(names).map((name) => [name, readFileSync(path.join(directory, name))]))
  const assets = [...bytes.keys()].map((name) => ({name, id: name}))
  const restored = mkdtempSync(path.join(tmpdir(), "coordinated-restored-"))
  t.after(() => rmSync(restored, {recursive: true, force: true}))
  const deps = {
    resolve: () => ({id: 123}),
    list: async () => assets,
    download: async (repo, asset, file) => writeFileSync(file, bytes.get(asset.name)),
  }
  assert.equal(await restoreDownloads(restored, plan, repository, ota, deps), true)
  assert.deepEqual(readFileSync(path.join(restored, names.mac)), bytes.get(names.mac))
  assert.equal(await restoreDownloads(restored, plan, repository, ota, {...deps, list: async () => []}), false)
  await assert.rejects(
    restoreDownloads(restored, plan, repository, ota, {
      ...deps,
      list: async () => assets.filter((asset) => asset.name !== names.mac),
    }),
    /missing or duplicate/,
  )
  bytes.set(names.iphone, Buffer.from("different signed bytes"))
  await assert.rejects(restoreDownloads(restored, plan, repository, ota, deps), /bytes disagree/)
})

test("coordinated routine links select the exact source and archive without claiming execution", async () => {
  for (const channel of ["dev", "staging"]) {
    const {state, options} = coordinatedFixture(channel)
    const env = {BRANCH: channel, RELEASE_SCOPE: "core", FINALIZE_RESULT: "success", RELEASE_PAGE_RESULT: "success",
      EXAMPLES_DISPATCH_RESULT: "success", RELEASE_IDENTITY: state.plan.releaseIdentity,
      REPOSITORY: "Mentra-Community/MentraOS", SHA: state.plan.sourceCommit, RUN_ID: "100", RUN_ATTEMPT: "2",
      MAC_URL: state.receipt.app.otaManifestUrl.replace(state.plan.artifactNames.otaManifest, state.receipt.artifacts.mac.name)}
    const blocks = await coordinatedRoutineLinks(env, options.fetchImpl)
    const text = blocks[0].text.text
    assert.match(text, /execution and results are pending/)
    assert.doesNotMatch(text, /test passed|test succeeded|queued/i)
    const results = new URL(text.match(/<(https:\/\/admin\.dev\.[^|]+)\|/)[1])
    assert.equal(results.searchParams.get("headSha"), state.plan.sourceCommit)
    assert.equal(results.searchParams.get("archiveSha256"), state.receipt.artifacts.mac.sha256)
    assert.equal(results.searchParams.get("routineId"), "no-glasses")
    assert.equal(results.searchParams.get("channel"), channel)
    assert.equal(results.searchParams.has("pr"), false)
    const pipeline = new URL(text.match(/<(https:\/\/github\.com\/[^|]+)\|/)[1])
    assert.equal(pipeline.searchParams.get("query"), '"Device request callback 100 / attempt 2"')
    for (const override of [{FINALIZE_RESULT: "failure"}, {MAC_URL: "https://other.example/app.zip"}, {SHA: "f".repeat(40)}]) {
      const unavailable = JSON.stringify(await coordinatedRoutineLinks({...env, ...override}, options.fetchImpl))
      assert.match(unavailable, /Unavailable/)
      assert.doesNotMatch(unavailable, /Results for this exact build/)
    }
    for (const key of ["RELEASE_PAGE_RESULT", "EXAMPLES_DISPATCH_RESULT"]) for (const result of ["failure", "cancelled", "skipped", undefined]) {
      const notRequested = JSON.stringify(await coordinatedRoutineLinks({...env, [key]: result}, options.fetchImpl))
      assert.match(notRequested, /Not requested/)
      assert.doesNotMatch(notRequested, /pending/)
      assert.match(notRequested, /Results for this exact build/, "A published artifact remains reviewable even when the callback cannot run")
    }
    assert.deepEqual(await coordinatedRoutineLinks({...env, RELEASE_SCOPE: "examples"}, options.fetchImpl), [])
  }
})
