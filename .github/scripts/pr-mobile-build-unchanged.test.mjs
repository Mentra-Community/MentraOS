import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import test from "node:test"
import {androidReceiptName, validateAndroidReceipt} from "./pr-android-artifacts.mjs"
import {iosReceiptName, validateIosReceipt} from "./pr-ios-artifacts.mjs"
import {findUnchangedBuild, otaContent, publishUnchangedReceipt} from "./pr-mobile-build-unchanged.mjs"
import {PACKAGING_PATHS, packagingFingerprint} from "./pr-mobile-build.mjs"
import {artifactUrl} from "./release-artifact-storage.mjs"

const repository = "Mentra-Community/Mentra"
const earlier = "a".repeat(40), head = "b".repeat(40), fingerprint = "d".repeat(64), packaging = "6".repeat(64)
const profile = "11111111-2222-3333-4444-555555555555"
const url = (name) => artifactUrl(repository, "pr-builds", name)
const ota = (sha) => url(`ota-pr-7-${sha}.json`)
const now = Date.parse("2026-11-05T12:00:00Z")
const daysAgo = (days) => new Date(now - days * 86400000).toISOString()
const env = {GITHUB_REPOSITORY: repository, PR_NUMBER: "7", PR_HEAD_SHA: head, MENTRA_PR_MOBILE_FINGERPRINT: fingerprint,
  EXPO_PUBLIC_BUILD_ENV: "dev", PR_OTA_MANIFEST_URL: ota(head), GITHUB_RUN_ID: "200", GITHUB_RUN_ATTEMPT: "1",
  MENTRAOS_PINNED_BUILD_NUMBER: "305000100"}

const androidName = androidReceiptName(7, earlier, 100, 1)
const androidReceipt = () => ({schemaVersion: 1, pr: 7, headSha: earlier, baseSha: "e".repeat(40), buildSha: "f".repeat(40),
  runId: 100, runAttempt: 1, packagingFingerprint: packaging,
  app: {packageId: "com.mentra.mentra", version: "3.5.0", build: "305000100", headSha: earlier, buildSha: "f".repeat(40),
    backend: "dev", otaManifestUrl: ota(earlier), mobileFingerprint: fingerprint, mobileSourceCommit: "c".repeat(40)},
  artifacts: {android: {name: androidName.replace(/\.json$/, ".apk"), sha256: "1".repeat(64), size: 323_000_000}}})

const iosName = iosReceiptName(7, earlier, 100, 2)
const iosReceipt = () => {
  const files = {iphone: "ipa", mac: "zip", manifest: "plist", install: "html"}
  return {schemaVersion: 2, pr: 7, headSha: earlier, buildSha: "f".repeat(40), runId: 100, runAttempt: 2, buildAttempt: 1,
    packagingFingerprint: packaging,
    app: {bundleId: "com.mentra.mentra", headSha: earlier, backend: "dev", otaManifestUrl: ota(earlier), profileUUID: profile,
      mobileFingerprint: fingerprint, macPackageVersion: 2, macInstaller: "Install Mentra.app", version: "3.5.0", build: "305000100"},
    macInstaller: {bundleId: "com.mentra.mac-installer", teamId: "T5XXXL6N36", notarizationStatus: "Accepted", stapled: true,
      notarizationId: "01234567-89ab-cdef-0123-456789abcdef"},
    artifacts: Object.fromEntries(Object.entries(files).map(([kind, ext]) =>
      [kind, {name: `mentra-ios-${kind}-pr-7-${earlier}-100-1.${ext}`, sha256: "2".repeat(64), size: 1000}]))}
}

const manifest = (sha, change = (value) => value) => change({
  releaseVersion: `pr-7-${sha}`,
  asgSource: {fingerprint: "asg-source"},
  apps: {"com.mentra.asg_client": {versionName: "3.5.0-pr.7", versionCode: 7, sha256: "3".repeat(64), apkSize: 10,
    apkUrl: url(`asg-pr-7-${sha}-${"3".repeat(64)}.apk`)}},
  bes_firmware: {version: "26.9.7.0", sha256: "4".repeat(64), url: url(`bes-pr-7-${sha}-${"4".repeat(64)}.bin`)},
  mtk_full_ota: {end_firmware: "MentraLive_20260908.0", url: "https://mtkfirmware.mentraglass.com/full.zip"},
  mtk_patches: [{start_firmware: "MentraLive_20260801.0", end_firmware: "MentraLive_20260908.0"}],
})

function harness(platform = "android", options = {}) {
  const receipt = options.receipt ?? (platform === "ios" ? iosReceipt() : androidReceipt())
  const name = platform === "ios" ? iosName : androidName
  const state = {
    files: {[url(name)]: receipt, [ota(earlier)]: manifest(earlier), [ota(head)]: manifest(head)},
    assets: [{name, created_at: daysAgo(1)},
      ...Object.values(receipt.artifacts).map((file) => ({name: file.name, size: file.size, created_at: daysAgo(1)}))],
    asgStatus: "completed",
    ...options,
  }
  const outputs = {}, warnings = [], waits = []
  return {
    state, outputs, warnings, waits,
    args: {
      github: {rest: {actions: {listWorkflowRuns: async ({workflow_id, head_sha}) => {
        assert.equal(workflow_id, "mentra-asg-client-build.yml")
        assert.equal(head_sha, head)
        return {data: {workflow_runs: [{display_title: "No build: label change", status: "queued"}, {status: state.asgStatus}]}}
      }}}},
      context: {repo: {owner: "Mentra-Community", repo: "Mentra"}},
      core: {setOutput: (key, value) => (outputs[key] = value), info() {}, warning: (value) => warnings.push(value)},
      platform,
      env,
      now: () => now,
      packaging: () => state.packaging ?? packaging,
      iosProfile: () => state.profile ?? profile,
      wait: async (ms) => waits.push(ms),
      readIndex: async (owner, tag) => {
        assert.deepEqual([owner, tag], [repository, "pr-builds"])
        return {assets: state.assets}
      },
      fetchImpl: async (address) => {
        const body = state.files[address.split("?")[0]]
        return body ? new Response(JSON.stringify(body)) : new Response("missing", {status: 404})
      },
    },
  }
}

for (const platform of ["android", "ios"]) {
  test(`${platform}: an earlier push with the same app and glasses software is reused`, async () => {
    const h = harness(platform)
    assert.equal(await findUnchangedBuild(h.args), platform === "ios" ? iosName : androidName)
    assert.deepEqual(h.outputs, {unchanged: "true", receipt: platform === "ios" ? iosName : androidName})
    assert.deepEqual(h.warnings, [])
  })
}

test("any difference, or anything unreadable, falls back to packaging this head", async () => {
  const stale = (assets) => assets.map((asset) => asset.name.endsWith(".apk") ? {...asset, created_at: daysAgo(5.5)} : asset)
  for (const [label, options, warns = false] of [
    ["another app", {receipt: {...androidReceipt(), app: {...androidReceipt().app, mobileFingerprint: "9".repeat(64)}}}],
    ["another backend", {receipt: {...androidReceipt(), app: {...androidReceipt().app, backend: "staging"}}}],
    ["a receipt that reuses another", {receipt: {...androidReceipt(), headSha: "c".repeat(40), reusedFrom: {headSha: earlier, runId: 1, runAttempt: 1}}}],
    ["an invalid receipt", {receipt: {...androidReceipt(), runAttempt: 2}}],
    ["a missing file", (h) => (h.state.assets = h.state.assets.filter((asset) => !asset.name.endsWith(".apk")))],
    ["a file of another size", (h) => (h.state.assets.find((asset) => asset.name.endsWith(".apk")).size = 1)],
    ["a file the sweep removes soon", (h) => (h.state.assets = stale(h.state.assets))],
    ["only this head's receipt", (h) => (h.state.assets = h.state.assets.map((asset) => ({...asset, name: asset.name.replaceAll(earlier, head)})))],
    ["another ASG client", (h) => (h.state.files[ota(head)].apps["com.mentra.asg_client"].sha256 = "5".repeat(64))],
    ["other ASG sources", (h) => (h.state.files[ota(head)].asgSource.fingerprint = "other")],
    ["another BES firmware", (h) => (h.state.files[ota(head)].bes_firmware.sha256 = "5".repeat(64))],
    ["another MTK image", (h) => (h.state.files[ota(head)].mtk_full_ota.end_firmware = "MentraLive_20261001.0")],
    ["other MTK patches", (h) => h.state.files[ota(head)].mtk_patches.push({start_firmware: "MentraLive_20260701.0"})],
    ["no published manifest", (h) => delete h.state.files[ota(head)]],
    ["an earlier manifest gone", (h) => delete h.state.files[ota(earlier)], true],
    ["a manifest without its ASG sources", (h) => delete h.state.files[ota(earlier)].asgSource, true],
    ["another revision's manifest", (h) => (h.state.files[ota(head)].releaseVersion = `pr-7-${earlier}`), true],
    ["an unreadable index", {assets: undefined}, true],
  ]) {
    const h = harness("android", typeof options === "function" ? {} : options)
    if (typeof options === "function") options(h)
    assert.equal(await findUnchangedBuild(h.args), undefined, label)
    assert.deepEqual(h.outputs, {unchanged: "false"}, label)
    assert.equal(h.warnings.length, warns ? 1 : 0, label)
  }
})

test("an earlier push's build is reused only at this head's number", async () => {
  // The receipts carry 305000100. A release since then moves this head to 305000103.
  for (const [platform, name] of [["android", androidName], ["ios", iosName]]) {
    for (const [pinned, reused] of [["305000100", true], ["305000103", false], ["305000099", false]]) {
      const h = harness(platform)
      h.args.env = {...h.args.env, MENTRAOS_PINNED_BUILD_NUMBER: pinned}
      assert.equal(await findUnchangedBuild(h.args), reused ? name : undefined, `${platform} ${pinned}`)
    }
  }
})

test("iOS: a refreshed provisioning profile, such as one with a new device, repackages", async () => {
  const h = harness("ios", {profile: "99999999-2222-3333-4444-555555555555"})
  assert.equal(await findUnchangedBuild(h.args), undefined)
  assert.deepEqual(h.outputs, {unchanged: "false"})
  const unknown = harness("ios")
  unknown.args.iosProfile = () => undefined
  assert.equal(await findUnchangedBuild(unknown.args), undefined)
  assert.equal(unknown.warnings.length, 1)
})

test("a push that changes only the packaging or installer republishes", async () => {
  for (const platform of ["android", "ios"]) {
    // Another packaging fingerprint, and a receipt from before it was recorded.
    const h = harness(platform, {packaging: "7".repeat(64)})
    assert.equal(await findUnchangedBuild(h.args), undefined, platform)
    const receipt = platform === "ios" ? iosReceipt() : androidReceipt()
    delete receipt.packagingFingerprint
    const old = harness(platform, {receipt})
    assert.equal(await findUnchangedBuild(old.args), undefined, platform)
  }
  // The installer page and plist generator is a packaging input of iOS publications.
  assert.ok(PACKAGING_PATHS.ios.includes(".github/scripts/pr-ios-artifacts-install.mjs"))
  for (const platform of ["android", "ios"]) {
    const tree = (installer) => (command, args, options) => {
      assert.deepEqual([command, ...args.slice(0, 4)], ["git", "ls-tree", "-r", "HEAD", "--"])
      assert.deepEqual(args.slice(4), PACKAGING_PATHS[platform])
      assert.ok(options.cwd.endsWith("/"))
      return PACKAGING_PATHS[platform].map((file) => `100644 blob ${file === PACKAGING_PATHS[platform][1] ? installer : "0".repeat(40)}\t${file}`).join("\n")
    }
    assert.notEqual(packagingFingerprint(platform, tree("1".repeat(40))), packagingFingerprint(platform, tree("2".repeat(40))))
  }
  assert.notEqual(packagingFingerprint("android"), packagingFingerprint("ios"))
})

test("names and URLs that differ per head are not compared", () => {
  assert.deepEqual(otaContent(manifest(earlier)), otaContent(manifest(head)))
  assert.throws(() => otaContent(manifest(head, (value) => ({...value, bes_firmware: {version: "26.9.7.0"}}))), /missing/)
})

test("waits for this head's manifest while its ASG run is in progress", async () => {
  const h = harness("android", {asgStatus: "in_progress"})
  const published = h.state.files[ota(head)]
  delete h.state.files[ota(head)]
  let clock = now
  h.args.now = () => clock
  h.args.wait = async (ms) => {
    h.waits.push(ms)
    clock += ms
    if (h.waits.length === 3) h.state.files[ota(head)] = published
  }
  assert.equal(await findUnchangedBuild(h.args), androidName)
  assert.deepEqual(h.waits, [15_000, 15_000, 15_000])
  // It gives up after ten minutes.
  const late = harness("android", {asgStatus: "in_progress"})
  delete late.state.files[ota(head)]
  let time = now
  late.args.now = () => time
  late.args.wait = async (ms) => (time += ms)
  assert.equal(await findUnchangedBuild(late.args), undefined)
})

test("the newest matching receipt is the one reused", async () => {
  const h = harness("android")
  const older = androidReceiptName(7, "c".repeat(40), 90, 1)
  h.state.assets.push({name: older, created_at: daysAgo(2)})
  h.state.files[url(older)] = {...androidReceipt(), headSha: "c".repeat(40)}
  assert.equal(await findUnchangedBuild(h.args), androidName)
  h.state.assets.find((asset) => asset.name === androidName).created_at = daysAgo(3)
  // The older-named receipt is now the newest, but it is not a valid publication.
  assert.equal(await findUnchangedBuild(h.args), androidName)
})

function publishing(platform) {
  const h = harness(platform)
  const calls = []
  const exec = (command, args) => {
    if (command === "gh") return "10\n"
    assert.equal(command, process.execPath)
    const file = args[args.indexOf("--file") + 1]
    calls.push({name: args[args.indexOf("--name") + 1], receipt: JSON.parse(readFileSync(file, "utf8")), args})
    return ""
  }
  return {calls, run: (name) => publishUnchangedReceipt(platform, name, env, {exec, fetchImpl: h.args.fetchImpl})}
}

test("Android: this head's receipt points at the earlier APK and validates for this head", async () => {
  const {calls, run} = publishing("android")
  const receipt = await run(androidName)
  const original = androidReceipt()
  assert.deepEqual(calls.map((call) => call.name), [androidReceiptName(7, head, 200, 1)])
  assert.deepEqual(calls[0].receipt, receipt)
  assert.ok(!calls[0].args.includes("--fingerprint") && !calls[0].args.includes("--replace"))
  assert.deepEqual(receipt.app, original.app)
  assert.deepEqual(receipt.artifacts, original.artifacts)
  assert.deepEqual(receipt.reusedFrom, {headSha: earlier, runId: 100, runAttempt: 1})
  assert.deepEqual([receipt.headSha, receipt.runId, receipt.runAttempt], [head, 200, 1])
  const coordinates = {pr: 7, sha: head, runId: 200, attempt: 1, repository}
  assert.equal(validateAndroidReceipt(receipt, coordinates), receipt.artifacts)
  for (const change of [(r) => (r.headSha = earlier), (r) => (r.reusedFrom.headSha = head), (r) => (r.reusedFrom.runId = 101),
    (r) => (r.reusedFrom.extra = 1), (r) => (r.app.headSha = head), (r) => (r.app.otaManifestUrl = ota(head)),
    (r) => (r.artifacts.android.name = androidReceiptName(7, head, 200, 1).replace(/\.json$/, ".apk"))]) {
    const value = structuredClone(receipt)
    change(value)
    assert.throws(() => validateAndroidReceipt(value, coordinates))
  }
  await assert.rejects(run(androidReceiptName(7, head, 1, 1)), /not an earlier publication/)
})

test("iOS: this head's receipt keeps the earlier build attempt with its origin", async () => {
  const {calls, run} = publishing("ios")
  const receipt = await run(iosName)
  const original = iosReceipt()
  assert.deepEqual(calls.map((call) => call.name), [iosReceiptName(7, head, 200, 1)])
  assert.deepEqual(receipt.app, original.app)
  assert.deepEqual(receipt.artifacts, original.artifacts)
  assert.deepEqual(receipt.macInstaller, original.macInstaller)
  assert.equal(receipt.buildAttempt, undefined)
  assert.deepEqual(receipt.reusedFrom, {headSha: earlier, runId: 100, runAttempt: 2, buildAttempt: 1})
  const coordinates = {pr: 7, sha: head, runId: 200, attempt: 1}
  assert.equal(validateIosReceipt(receipt, coordinates), receipt.artifacts)
  for (const change of [(r) => (r.reusedFrom.buildAttempt = 2), (r) => (r.app.headSha = head), (r) => (r.buildAttempt = 1),
    (r) => (r.app.otaManifestUrl = ota(head)), (r) => (r.reusedFrom.headSha = head), (r) => (r.reusedFrom = null)]) {
    const value = structuredClone(receipt)
    change(value)
    assert.throws(() => validateIosReceipt(value, coordinates))
  }
})

test("iOS: the Bluetooth example app reuses only its own earlier publication", async () => {
  const exampleEnv = {...env, MENTRA_PR_APP: "example"}
  const h = harness("ios")
  h.args.env = exampleEnv
  // Only the Mentra App's publication.
  assert.equal(await findUnchangedBuild(h.args), undefined)
  const name = iosReceiptName(7, earlier, 100, 2, "example")
  const original = iosReceipt()
  const receipt = {...original,
    app: {...original.app, bundleId: "com.mentra.bluetoothsdkexample", macInstaller: "Install Mentra Example.app"},
    macInstaller: {...original.macInstaller, bundleId: "com.mentra.mac-installer.example"},
    artifacts: Object.fromEntries(Object.entries(original.artifacts).map(([kind, file]) =>
      [kind, {...file, name: file.name.replace("mentra-", "mentra-example-")}]))}
  h.state.files[url(name)] = receipt
  h.state.assets.push({name, created_at: daysAgo(1)},
    ...Object.values(receipt.artifacts).map((file) => ({name: file.name, size: file.size, created_at: daysAgo(1)})))
  assert.equal(await findUnchangedBuild(h.args), name)

  const calls = []
  const exec = (command, args) => {
    if (command === "gh") return "10\n"
    calls.push(args[args.indexOf("--name") + 1])
    return ""
  }
  const published = await publishUnchangedReceipt("ios", name, exampleEnv, {exec, fetchImpl: h.args.fetchImpl})
  assert.deepEqual(calls, [`mentra-example-ios-pr-7-${head}-200-1.json`])
  assert.equal(validateIosReceipt(published, {pr: 7, sha: head, runId: 200, attempt: 1, app: "example"}), published.artifacts)
  assert.deepEqual(published.artifacts, receipt.artifacts)
})
