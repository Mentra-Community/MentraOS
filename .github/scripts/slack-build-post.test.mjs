import assert from "node:assert/strict"
import test from "node:test"
import {prBuildPost} from "./notify-pr-builds.mjs"
import {releasePost} from "./release-slack-post.mjs"
import {buildPost, installButtons, slackText} from "./slack-build-post.mjs"

// Every build post, from fixtures: each must have the one layout.
const sha = "4983fcb018c0ffee4983fcb018c0ffee4983fcb0"
const cdn = "https://artifactscdn.mentraglass.com/Mentra-Community/Mentra/releases/pr-builds"
const pr = {number: 1159, title: "Redesign the Slack build posts", html_url: "https://github.com/Mentra-Community/Mentra/pull/1159",
  head: {ref: "claude/slack-build-posts"}, base: {ref: "dev"}, user: {login: "someone"}}
const targets = {asg: {versionName: "3.4.0", versionCode: 340012, apkUrl: `${cdn}/asg.apk`}, bes: "26.11.4.0", mtk: "MentraLive_20261101.0"}
const run = (id) => `https://github.com/Mentra-Community/Mentra/actions/runs/${id}`
const ios = {assets: {install: `${cdn}/i.html`, iphone: `${cdn}/i.ipa`, mac: `${cdn}/m.zip`}, macInstallUrl: `${cdn}/i.html?platform=mac&attempt=1`, runUrl: run(3)}
const prBase = {pr, sha, androidUrl: `${cdn}/a.apk`, targets, androidRunUrl: run(2), backend: "dev",
  details: "https://github.com/Mentra-Community/Mentra/pull/1159#issuecomment-1"}
const rcdn = "https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/mentra-v3.4.0-dev.12"
const releaseEnv = {BRANCH: "dev", REPOSITORY: "Mentra-Community/MentraOS", RUN_REPOSITORY: "Mentra-Community/Mentra", RUN_ID: "100",
  RUN_ATTEMPT: "1", SHA: sha, COMMIT_MESSAGE: "Merge pull request #1152", COMMIT_AUTHOR: "someone", RELEASE_IDENTITY: "3.4.0-dev.12",
  FINALIZE_RESULT: "success", ANDROID_RESULT: "success", IOS_RESULT: "success", OTA_RESULT: "success",
  MOBILE_APK_URL: `${rcdn}/mentra.apk`, IPHONE_MANIFEST_URL: `${rcdn}/i.plist`, IPHONE_SHARE_URL: `${rcdn}/i.html`, MAC_URL: `${rcdn}/m.zip`,
  OTA_MANIFEST_URL: `${rcdn}/ota.json`, EXAMPLE_APK_URL: `${rcdn}/example.apk`, EXAMPLE_TESTFLIGHT_INSTALL_URL: "https://testflight.apple.com/join/x"}
const manifest = (releaseVersion) => ({releaseVersion, apps: {"com.mentra.asg_client": {versionName: "3.4.0", versionCode: 340012}},
  bes_firmware: {version: "26.11.4.0"}, mtk_full_ota: {end_firmware: "MentraLive_20261101.0"}})
const jobs = {jobs: [{id: 77, name: "Mobile / Build and distribute coordinated iOS app", conclusion: "failure", steps: []}]}
const release = (env) => releasePost({...releaseEnv, ...env}, {check: async () => true,
  fetchImpl: async (url) => new Response(JSON.stringify(url.endsWith("ota.json") ? manifest(env.RELEASE_IDENTITY ?? releaseEnv.RELEASE_IDENTITY) : jobs))})

const posts = async () => ({
  "PR ready, with the Bluetooth example": [prBuildPost({...prBase, ios, example: {androidUrl: `${cdn}/example.apk`,
    iphoneUrl: `${cdn}/example-i.html`, macUrl: `${cdn}/example-m.zip`}}), {ok: true, example: true}],
  "PR ready, Android only": [prBuildPost({...prBase, ios: {}}), {ok: true}],
  "PR incomplete": [prBuildPost({...prBase, ios: {error: "iOS failure", runUrl: run(3)}, example: {error: "Android failure", runUrl: run(2)}}),
    {ok: false}],
  "dev release, complete": [await release({}), {ok: true, example: true}],
  "staging release, incomplete": [await release({BRANCH: "staging", RELEASE_IDENTITY: "3.4.0-beta.3", FINALIZE_RESULT: "failure",
    IOS_RESULT: "failure"}), {ok: false, example: true}],
})

test("every build post has the one layout: title and Details, facts, one row of buttons, glasses, problems", async () => {
  for (const [name, [post, {ok, example}]] of Object.entries(await posts())) {
    const [title, facts, ...rest] = post.blocks
    assert.equal(title.type, "section", name)
    assert.match(title.text.text, ok ? /^\*✅ / : /^\*⚠️ /, name)
    assert.equal(title.accessory.text.text, "Details", name)
    assert.equal(facts.type, "context", name)
    const actions = rest.filter((block) => block.type === "actions")
    assert.equal(actions.length, 1, name)
    const buttons = actions[0].elements
    // The Mentra App's buttons first and green, then the Bluetooth example's.
    const first = buttons.findIndex((button) => !button.style)
    assert.ok(buttons.slice(0, first < 0 ? undefined : first).every((button) => button.style === "primary" && !/Bluetooth/.test(button.text.text)), name)
    assert.equal(buttons.some((button) => /Bluetooth example/.test(button.text.text)), Boolean(example), name)
    // Each app has the same slots, Docs closes the row, and a slot without an install is named under it.
    const slots = buttons.slice(0, -1).map((button) => button.text.text.split(" ")[0])
    assert.deepEqual([buttons.at(-1).text.text, buttons.at(-1).url], [":books: Docs", "https://docs-dev.mentraglass.com".replace(
      "docs-dev", name.startsWith("staging") ? "docs-beta" : "docs-dev")], name)
    const after = rest[rest.indexOf(actions[0]) + 1]
    const missing = /^:heavy_minus_sign: Missing: /.test(after.elements?.[0].text)
    if (example && !missing) assert.deepEqual(slots.slice(0, slots.length / 2), slots.slice(slots.length / 2), name)
    const glasses = missing ? rest[rest.indexOf(actions[0]) + 2] : after
    assert.match(glasses.elements[0].text, /^:dark_sunglasses: ASG \*3\.4\.0\* \(build 340012\) · BES/, name)
    const problems = rest.filter((block) => block.type === "section")
    assert.equal(problems.length > 0, !ok, name)
    assert.ok(problems.every((block) => /^:warning: /.test(block.text.text) && block.accessory?.text.text === "Logs"), name)
    // Buttons, never links: no mrkdwn link and every URL an HTTPS button's.
    assert.doesNotMatch(JSON.stringify(post.blocks), /<https?:|itms-services/, name)
    const urls = JSON.stringify(post.blocks).match(/"url":"[^"]+"/g)
    assert.ok(urls.every((url) => url.startsWith('"url":"https://')), name)
  }
})

test("buttons skip non-HTTPS URLs; nothing to install leaves no actions block", () => {
  assert.deepEqual(installButtons([{name: "Mentra App", installs: [{platform: "Android", url: "itms-services://x"},
    {platform: "macOS", url: undefined}]}]), [])
  const post = buildPost({text: "t", title: "*t*", apps: [{name: "Mentra App", installs: []}]})
  assert.ok(post.blocks.every((block) => block.type !== "actions"))
  assert.equal(slackText("&<>\n".repeat(2), 6), "&amp;&lt;&gt; &amp;…")
})
