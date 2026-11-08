import assert from "node:assert/strict"
import test from "node:test"
import {notifyRelease, releaseFailureDetail, releasePost} from "./release-slack-post.mjs"
import {otaTargets} from "./slack-build-post.mjs"

const manifest = {
  releaseVersion: "3.2.0-dev.265",
  apps: {"com.mentra.asg_client": {versionName: "3.2.0", versionCode: 302000265}},
  bes_firmware: {version: "26.9.21.1"},
  mtk_full_ota: {end_firmware: "MentraLive_20260915.0"},
}
const cdn = "https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/mentra-v3.2.0-dev.265"
const env = {
  BRANCH: "dev",
  REPOSITORY: "Mentra-Community/MentraOS",
  RUN_REPOSITORY: "Mentra-Community/Mentra",
  RUN_ID: "100",
  RUN_ATTEMPT: "2",
  SHA: "a".repeat(40),
  COMMIT_MESSAGE: "Ship the <thing> & more\n\nbody",
  COMMIT_AUTHOR: "Someone",
  RELEASE_IDENTITY: "3.2.0-dev.265",
  FINALIZE_RESULT: "success",
  ANDROID_RESULT: "success",
  IOS_RESULT: "success",
  OTA_RESULT: "success",
  MOBILE_APK_URL: `${cdn}/mentra.apk`,
  IPHONE_MANIFEST_URL: `${cdn}/i.plist`,
  IPHONE_SHARE_URL: `${cdn}/i.html`,
  MAC_URL: `${cdn}/m.zip`,
  OTA_MANIFEST_URL: `${cdn}/ota.json`,
}
const json = (value) => new Response(JSON.stringify(value))
const ok = async () => true
const otaOnly = async (url) => (url === env.OTA_MANIFEST_URL ? json(manifest) : assert.fail(`Unexpected request ${url}`))
const buttons = (post) => post.blocks.find((block) => block.type === "actions")?.elements.map((element) => element.text.text) ?? []
const text = (post) => JSON.stringify(post.blocks)

const missing = (post) => post.blocks.find((block) => block.type === "context" && block.elements[0].text.includes("Missing:"))?.elements[0].text

test("a finished release is a title, one row of buttons and the glasses versions", async () => {
  const post = await releasePost({...env, ANDROID_VERSION_CODE: "304000123", IOS_BUILD_NUMBER: "304000120",
    EXAMPLES_RESULT: "success", EXAMPLE_APK_URL: `${cdn}/example.apk`, EXAMPLE_TESTFLIGHT_RESULT: "success",
    EXAMPLE_TESTFLIGHT_INSTALL_URL: "https://testflight.apple.com/join/abc"}, {check: ok, fetchImpl: otaOnly})
  assert.deepEqual(post.blocks.map((block) => block.type), ["section", "context", "actions", "context", "context"])
  assert.equal(post.blocks[0].text.text, "*✅ Dev 3.2.0-dev.265 released*")
  assert.equal(post.blocks[0].accessory.url, "https://github.com/Mentra-Community/MentraOS/releases/tag/mentra-v3.2.0-dev.265")
  assert.equal(post.blocks[1].elements[0].text, "aaaaaaa Ship the &lt;thing&gt; &amp; more · by Someone · Android 304000123 · iOS 304000120")
  assert.deepEqual(buttons(post), [":robot_face: Install Mentra", ":apple: Install Mentra", ":computer: Install Mentra",
    ":robot_face: Install Bluetooth example", ":apple: Install Bluetooth example", ":books: Docs"])
  // The release builds no macOS example: its slot says so, for symmetry with the Mentra App's.
  assert.equal(missing(post), ":heavy_minus_sign: Missing: :computer: Bluetooth example (not built)")
  assert.match(post.blocks[4].elements[0].text, /ASG \*3\.2\.0\* \(build 302000265\) · BES \*26\.9\.21\.1\* · MTK \*MentraLive_20260915\.0\*/)
  // No inline links anywhere: every URL is a button's.
  assert.doesNotMatch(text(post), /<https?:|itms-services/)
})

test("both apps get Android and iOS, the store's when there is no page, and the channel's docs root", async () => {
  const stores = {...env, MOBILE_APK_URL: "", IPHONE_MANIFEST_URL: "", PLAY_INSTALL_URL: "https://play.google.com/apps/test/x",
    TESTFLIGHT_INSTALL_URL: "https://testflight.apple.com/join/app", TESTFLIGHT_DISTRIBUTION_STATUS: "available", EXAMPLES_RESULT: "success",
    EXAMPLE_GOOGLE_PLAY_INSTALL_URL: "https://play.google.com/apps/test/y", EXAMPLE_TESTFLIGHT_RESULT: "success",
    EXAMPLE_TESTFLIGHT_INSTALL_URL: "https://testflight.apple.com/join/abc", DOCS_URL: "https://docs-dev.mentraglass.com/example"}
  for (const [BRANCH, docs] of [["dev", "https://docs-dev.mentraglass.com"], ["staging", "https://docs-beta.mentraglass.com"]]) {
    const post = await releasePost({...stores, BRANCH}, {check: ok, fetchImpl: otaOnly})
    const actions = post.blocks.find((block) => block.type === "actions").elements
    assert.deepEqual(actions.map(({text, url}) => [text.text, url]), [
      [":robot_face: Install Mentra", stores.PLAY_INSTALL_URL], [":apple: Install Mentra", stores.TESTFLIGHT_INSTALL_URL],
      [":robot_face: Install Bluetooth example", stores.EXAMPLE_GOOGLE_PLAY_INSTALL_URL],
      [":apple: Install Bluetooth example", stores.EXAMPLE_TESTFLIGHT_INSTALL_URL], [":books: Docs", docs]])
    // The Mentra App's buttons stand out from the example's.
    assert.deepEqual(actions.map((button) => button.style), ["primary", "primary", undefined, undefined, undefined])
    assert.equal(missing(post), undefined)
  }
})

test("iOS opens TestFlight only once testers can install it", async () => {
  const testflight = {TESTFLIGHT_INSTALL_URL: "https://testflight.apple.com/join/app"}
  for (const [TESTFLIGHT_DISTRIBUTION_STATUS, url] of [["available", testflight.TESTFLIGHT_INSTALL_URL],
    ["submitted", env.IPHONE_SHARE_URL], ["skipped", env.IPHONE_SHARE_URL]]) {
    const post = await releasePost({...env, ...testflight, TESTFLIGHT_DISTRIBUTION_STATUS}, {check: ok, fetchImpl: otaOnly})
    assert.equal(post.blocks.find((block) => block.type === "actions").elements[1].url, url, TESTFLIGHT_DISTRIBUTION_STATUS)
  }
})

test("a slot without an install shows as missing, with why", async () => {
  const failed = await releasePost({...env, IOS_RESULT: "failure", EXAMPLES_RESULT: "failure", EXAMPLE_TESTFLIGHT_RESULT: "skipped"},
    {check: async (url) => url === env.MOBILE_APK_URL, fetchImpl: otaOnly})
  assert.deepEqual(buttons(failed), [":robot_face: Install Mentra", ":books: Docs"])
  assert.equal(missing(failed), ":heavy_minus_sign: Missing: :apple: Mentra (failed) · :robot_face: Bluetooth example (failed) · :apple: Bluetooth example (not built)")
  // Apple installs need their manifest, page and Mac app; a published URL that does not answer is not published.
  const unanswered = await releasePost({...env, EXAMPLES_RESULT: "success", EXAMPLE_APK_URL: `${cdn}/example.apk`},
    {check: async (url) => url !== env.MAC_URL && url !== `${cdn}/example.apk`, fetchImpl: otaOnly})
  assert.deepEqual(buttons(unanswered), [":robot_face: Install Mentra", ":books: Docs"])
  assert.match(missing(unanswered), /:apple: Mentra \(not published\) · :robot_face: Bluetooth example \(not published\)/)
})

test("an example, Play or docs failure is listed but never makes the release incomplete", async () => {
  const post = await releasePost({...env, EXAMPLES_RESULT: "failure", EXAMPLE_GOOGLE_PLAY_RESULT: "failure", DOCS_RESULT: "cancelled",
    CLOUD_V2_RESULT: "success"}, {check: ok, fetchImpl: otaOnly})
  assert.match(post.blocks[0].text.text, /released/)
  const problems = post.blocks.filter((block) => block.type === "section").slice(1)
  assert.equal(problems.length, 1)
  assert.equal(problems[0].text.text, ":warning: *Failed:* Bluetooth example builds, Bluetooth example Google Play · *Cancelled:* Docs")
  assert.equal(problems[0].accessory.url, "https://github.com/Mentra-Community/Mentra/actions/runs/100")
})

test("an unfinished release names the failed job and step, with its logs", async () => {
  const ios = {id: 123, name: "Build and distribute MentraOS mobile apps / Build and distribute coordinated iOS app", conclusion: "failure",
    steps: [{name: "Check Mapbox SDK download authentication", conclusion: "failure"}]}
  const fetchImpl = async (url) => url === env.OTA_MANIFEST_URL ? json(manifest) : json({jobs: [{id: 122, name: "Other", conclusion: "failure"}, ios]})
  for (const BRANCH of ["dev", "staging"]) {
    const post = await releasePost({...env, BRANCH, IOS_RESULT: "failure", FINALIZE_RESULT: "failure"}, {check: ok, fetchImpl})
    assert.match(post.blocks[0].text.text, /⚠️ (Dev|Staging) release 3\.2\.0-dev\.265 incomplete/)
    const [failure, failed] = post.blocks.filter((block) => block.type === "section").slice(1)
    assert.equal(failure.text.text, ":warning: *Release did not finish:* iOS/Mac build failed during “Check Mapbox SDK download authentication”.")
    assert.equal(failure.accessory.url, "https://github.com/Mentra-Community/Mentra/actions/runs/100/job/123")
    assert.match(failed.text.text, /\*Failed:\* iOS$/)
  }
  const failedPost = await releasePost({...env, ANDROID_RESULT: "failure", IOS_RESULT: "failure", OTA_RESULT: "failure",
    FINALIZE_RESULT: "skipped"}, {check: ok, fetchImpl})
  assert.match(failedPost.blocks[0].text.text, /❌ Dev release 3\.2\.0-dev\.265 failed/)
  // Only the examples: nothing for the Mentra release to report.
  const examples = await releasePost({...env, RELEASE_SCOPE: "examples", FINALIZE_RESULT: "skipped"}, {check: ok, fetchImpl: otaOnly})
  assert.doesNotMatch(text(examples), /Release did not finish/)
})

test("failure details survive API outages and escape Slack markup", async () => {
  for (const fetchImpl of [async () => new Response("private provider error", {status: 403}), async () => json({jobs: []}),
    async () => { throw new Error("private provider error") }]) {
    const detail = await releaseFailureDetail({...env, MAC_URL: "", MOBILE_APK_URL: ""}, fetchImpl)
    assert.equal(detail.text, "The release did not publish an installable app build.")
    assert.equal(detail.url, "https://github.com/Mentra-Community/Mentra/actions/runs/100/attempts/2")
  }
  const job = {id: 9, name: "Publish / Finalize release", conclusion: "cancelled", steps: [{name: "Verify <metadata> & build", conclusion: "cancelled"}]}
  assert.equal((await releaseFailureDetail(env, async () => json({jobs: [job]}))).text,
    "Finalize release was cancelled during “Verify &lt;metadata&gt; &amp; build”.")
})

test("a failed download page sends Details to the artifact container; no identity, to the run", async () => {
  const page = await releasePost({...env, RELEASE_PAGE_RESULT: "failure"}, {check: ok, fetchImpl: otaOnly})
  assert.equal(page.blocks[0].accessory.url, "https://github.com/Mentra-Community/MentraOS/releases/tag/mentra-builds-v3.2.0")
  assert.match(text(page), /\*Failed:\* Download page/)
  const unknown = await releasePost({...env, RELEASE_IDENTITY: "", FINALIZE_RESULT: "failure", ANDROID_RESULT: "failure",
    IOS_RESULT: "failure", OTA_RESULT: "failure", OTA_MANIFEST_URL: ""}, {check: ok, fetchImpl: async () => json({jobs: []})})
  assert.match(unknown.blocks[0].text.text, /identity allocation failed/)
  assert.equal(unknown.blocks[0].accessory.url, "https://github.com/Mentra-Community/Mentra/actions/runs/100")
})

test("glasses versions must belong to this release", async () => {
  assert.equal(otaTargets(manifest, manifest.releaseVersion).asg.versionCode, 302000265)
  assert.throws(() => otaTargets(manifest, "3.2.0-dev.266"), /different build/)
  const post = await releasePost({...env, RELEASE_IDENTITY: "3.2.0-dev.266"}, {check: ok, fetchImpl: otaOnly})
  assert.match(text(post), /Glasses versions unavailable \(OTA manifest belongs to a different build\)/)
})

test("posts once to the channel's webhook, and skips a channel without one", async (t) => {
  const log = t.mock.method(console, "log", () => {})
  const requests = []
  const fetchImpl = async (url, init) => {
    if (url === env.OTA_MANIFEST_URL) return json(manifest)
    requests.push({url, body: JSON.parse(init.body)})
    return new Response("ok")
  }
  await notifyRelease({...env, DEV_SLACK_WEBHOOK_URL: "https://hooks.example.invalid/dev"}, {check: ok, fetchImpl})
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, "https://hooks.example.invalid/dev")
  assert.equal(requests[0].body.text, "Mentra dev release 3.2.0-dev.265 released")
  await notifyRelease(env, {check: ok, fetchImpl})
  await notifyRelease({...env, BRANCH: "main"}, {check: ok, fetchImpl})
  assert.equal(requests.length, 1)
  assert.match(log.mock.calls.map((call) => call.arguments[0]).join("\n"), /DEV_SLACK_WEBHOOK_URL is not set[\s\S]*branch main/)
})
