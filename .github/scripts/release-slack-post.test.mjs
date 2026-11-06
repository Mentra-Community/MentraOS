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

test("a finished release is a title, one row of buttons and the glasses versions", async () => {
  const post = await releasePost({...env, ANDROID_VERSION_CODE: "304000123", IOS_BUILD_NUMBER: "304000120"}, {check: ok, fetchImpl: otaOnly})
  assert.deepEqual(post.blocks.map((block) => block.type), ["section", "context", "actions", "context"])
  assert.equal(post.blocks[0].text.text, "*✅ Dev 3.2.0-dev.265 released*")
  assert.equal(post.blocks[0].accessory.url, "https://github.com/Mentra-Community/MentraOS/releases/tag/mentra-v3.2.0-dev.265")
  assert.equal(post.blocks[1].elements[0].text, "aaaaaaa Ship the &lt;thing&gt; &amp; more · by Someone · Android 304000123 · iOS 304000120")
  assert.deepEqual(buttons(post), [":robot_face: Android", ":iphone: iPhone", ":computer: Mac"])
  assert.match(post.blocks[3].elements[0].text, /ASG \*3\.2\.0\* \(build 302000265\) · BES \*26\.9\.21\.1\* · MTK \*MentraLive_20260915\.0\*/)
  // No inline links anywhere: every URL is a button's.
  assert.doesNotMatch(text(post), /<https?:|itms-services/)
})

test("the Bluetooth example's installs follow the Mentra App's, only those it published", async () => {
  const example = {
    EXAMPLE_APK_URL: `${cdn}/mentra-example-react-native-3.2.0-dev.265.apk`,
    EXAMPLE_IPHONE_SHARE_URL: `${cdn}/example-i.html`,
    EXAMPLE_MAC_URL: `${cdn}/example-m.zip`,
    EXAMPLE_TESTFLIGHT_INSTALL_URL: "https://testflight.apple.com/join/abc",
    DOCS_URL: "https://docs-dev.mentraglass.com",
    TESTFLIGHT_INSTALL_URL: "https://testflight.apple.com/join/app",
  }
  const post = await releasePost({...env, ...example}, {check: ok, fetchImpl: otaOnly})
  assert.deepEqual(buttons(post), [":robot_face: Android", ":iphone: iPhone", ":computer: Mac", ":apple: TestFlight",
    ":robot_face: Bluetooth example Android", ":iphone: Bluetooth example iPhone", ":computer: Bluetooth example Mac",
    ":apple: Bluetooth example TestFlight", ":books: Bluetooth example Docs"])
  const actions = post.blocks.find((block) => block.type === "actions").elements
  assert.ok(actions.slice(0, 4).every((button) => button.style === "primary"))
  assert.ok(actions.slice(4).every((button) => button.style === undefined))
  // An example download that does not answer has no button.
  const missing = await releasePost({...env, ...example}, {check: async (url) => url !== example.EXAMPLE_APK_URL, fetchImpl: otaOnly})
  assert.doesNotMatch(buttons(missing).join(), /Bluetooth example Android/)
  assert.doesNotMatch(buttons(await releasePost(env, {check: ok, fetchImpl: otaOnly})).join(), /Bluetooth example/)
})

test("Apple installs need their manifest, page and Mac app; an old release links its store IPA", async () => {
  assert.deepEqual(buttons(await releasePost(env, {check: async (url) => url !== env.MAC_URL, fetchImpl: otaOnly})), [":robot_face: Android"])
  const old = {...env, IPHONE_MANIFEST_URL: "", MOBILE_IPA_URL: `${cdn}/store.ipa`}
  const post = await releasePost(old, {check: ok, fetchImpl: otaOnly})
  assert.deepEqual(buttons(post), [":robot_face: Android", ":iphone: iPhone"])
  assert.match(text(post), /store\.ipa/)
  // Nothing published: no empty actions block, which Slack would refuse.
  assert.ok((await releasePost(env, {check: async () => false, fetchImpl: otaOnly})).blocks.every((block) => block.type !== "actions"))
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
