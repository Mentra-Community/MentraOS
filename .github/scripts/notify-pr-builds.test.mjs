import assert from "node:assert/strict"
import test from "node:test"
import {iosBuildRequired, buildPost, matchingAsgRun, notifyPrBuilds, readOtaTargets} from "./notify-pr-builds.mjs"

const sha = "a".repeat(40)
const pr = {
  number: 123,
  state: "open",
  title: "Feature <&>",
  html_url: "https://github.com/o/r/pull/123",
  head: {sha, ref: "feature", repo: {full_name: "o/r"}},
  base: {ref: "dev"},
  user: {login: "author"},
}
const manifest = {
  releaseVersion: `pr-123-${sha}`,
  apps: {
    "com.mentra.asg_client": {
      versionName: "3.2.0",
      versionCode: 123,
      apkUrl: "https://example.com/asg.apk",
      apkSize: 10,
      sha256: "b".repeat(64),
    },
  },
  bes_firmware: {version: "26.9.7.0"},
  mtk_full_ota: {end_firmware: "MentraLive_20260908.0"},
  mtk_patches: [{end_firmware: "WRONG"}],
}
const run = {
  id: 1,
  run_attempt: 1,
  status: "completed",
  conclusion: "success",
  event: "pull_request",
  head_sha: sha,
  head_branch: "feature",
  head_repository: {full_name: "o/r"},
  html_url: "https://github.com/o/r/actions/runs/1",
}

test("uses explicit full MTK target and rejects stale/incomplete manifests", () => {
  assert.equal(readOtaTargets(manifest, 123, sha).mtk, "MentraLive_20260908.0")
  assert.throws(() => readOtaTargets(manifest, 124, sha), /different PR/)
  assert.throws(() => readOtaTargets({...manifest, mtk_full_ota: undefined}, 123, sha), /missing/)
})
test("ASG reuse accepts overall workflow success; unrelated runs are ignored", () => {
  assert.equal(matchingAsgRun([run, {...run, id: 2, head_sha: "other"}], pr, sha), run)
})
test("Slack escapes PR text and includes all three firmware targets", () => {
  const payload = buildPost({
    pr,
    sha,
    androidUrl: "https://example.com/a.apk",
    manifestUrl: "https://example.com/m.json",
    targets: readOtaTargets(manifest, 123, sha),
    androidRunUrl: run.html_url,
    asgRunUrl: run.html_url,
  })
  const body = JSON.stringify(payload.blocks)
  assert.match(body, /Feature &lt;&amp;&gt;/)
  assert.match(body, /26\.9\.7\.0/)
  assert.match(body, /MentraLive_20260908\.0/)
  assert.doesNotMatch(body, /WRONG|TestFlight|Google Play/)
})

const iosRun = {...run, id: 3}
const iosReceipt = {
  schemaVersion: 1,
  pr: 123,
  headSha: sha,
  buildSha: "b".repeat(40),
  runId: 3,
  runAttempt: 1,
  artifacts: Object.fromEntries(
    [
      ["iphone", "ipa"],
      ["mac", "zip"],
    ].map(([kind, ext]) => [
      kind,
      {
        name: `mentra-ios-${kind}-pr-123-${sha}-3-1.${ext}`,
        size: 10,
        sha256: "c".repeat(64),
      },
    ]),
  ),
}
function harness({
  asg = run,
  ios = iosRun,
  files = [],
  receipt = iosReceipt,
  comments = [],
  currentPr = pr,
  artifactStatus = 200,
  missingMac = false,
} = {}) {
  const posts = [],
    written = []
  const github = {
    rest: {
      pulls: {get: async () => ({data: currentPr}), listFiles: "files"},
      actions: {
        listWorkflowRuns: async ({workflow_id}) => ({
          data: {
            workflow_runs: [
              workflow_id === "mentra-app-ios-build.yml" ? (typeof ios === "function" ? ios() : ios) : asg,
            ].filter(Boolean),
          },
        }),
      },
      issues: {
        listComments: {},
        createComment: async (v) => written.push(v),
        updateComment: async (v) => written.push(v),
      },
    },
    paginate: async (method) => (method === "files" ? files : comments),
  }
  const fetchImpl = async (url, options) => {
    if (options.method === "POST") {
      posts.push(JSON.parse(options.body))
      return new Response("ok")
    }
    return new Response(
      options.method === "HEAD" ? null : JSON.stringify(url.includes("mentra-ios-pr-") ? receipt : manifest),
      {
        status: missingMac && url.endsWith(".zip") ? 404 : artifactStatus,
        headers: {"content-length": "10"},
      },
    )
  }
  return {
    posts,
    written,
    args: {
      github,
      context: {repo: {owner: "o", repo: "r"}, payload: {pull_request: pr}, runId: 2},
      core: {info() {}, warning() {}},
      fetchImpl,
      wait: async () => {},
      attempts: 1,
    },
  }
}

test("notification waits for both outputs, deduplicates reruns, suppresses superseded/cancelled runs", async () => {
  process.env.SLACK_WEBHOOK_PR_BUILDS = "https://example.com/webhook"
  process.env.ANDROID_RESULT = "success"
  const ready = harness()
  await notifyPrBuilds(ready.args)
  assert.equal(ready.posts.length, 1)
  assert.match(ready.posts[0].text, /ready to test/)
  const comment = {id: 1, user: {type: "Bot"}, body: ready.written[0].body}
  const duplicate = harness({comments: [comment]})
  await notifyPrBuilds(duplicate.args)
  assert.equal(duplicate.posts.length, 0)
  const stale = harness({currentPr: {...pr, head: {...pr.head, sha: "other"}}})
  await notifyPrBuilds(stale.args)
  assert.equal(stale.posts.length, 0)
  const cancelled = harness({asg: {...run, conclusion: "cancelled"}})
  await notifyPrBuilds(cancelled.args)
  assert.equal(cancelled.posts.length, 0)
  const unavailable = harness({artifactStatus: 404})
  await notifyPrBuilds(unavailable.args)
  assert.match(unavailable.posts[0].text, /incomplete/)
  const failed = harness({asg: {...run, conclusion: "failure"}})
  await notifyPrBuilds(failed.args)
  assert.match(failed.posts[0].text, /incomplete/)
  const recovered = harness({comments: [{...comment, body: failed.written[0].body}]})
  await notifyPrBuilds(recovered.args)
  assert.match(recovered.posts[0].text, /ready to test/)
})

test("iOS path applicability matches its filtered workflow", () => {
  assert.equal(iosBuildRequired([{filename: "cloud-v2/core/index.ts"}]), false)
  for (const filename of [
    "mobile/app.config.ts",
    ".github/workflows/mentra-app-ios-build.yml",
    ".github/scripts/pr-ios-artifacts.test.mjs",
  ])
    assert.equal(iosBuildRequired([{filename}]), true)
})

test("waits for slow iOS and includes both verified downloads", async () => {
  let polls = 0
  const h = harness({
    files: [{filename: "mobile/app.config.ts"}],
    ios: () => (++polls < 3 ? {...iosRun, status: "in_progress", conclusion: null} : iosRun),
  })
  await notifyPrBuilds({...h.args, attempts: 4})
  assert.equal(polls, 3)
  assert.equal(h.posts.length, 1)
  assert.match(h.written[0].body, /Download iPhone IPA/)
  assert.match(h.written[0].body, /Download Mac app/)
  assert.match(h.posts[0].text, /ready to test/)
})

test("iOS failure, missing or stale publication never advertises either download as ready", async () => {
  for (const options of [
    {ios: {...iosRun, conclusion: "failure"}},
    {ios: undefined},
    {missingMac: true},
    {receipt: {...iosReceipt, runAttempt: 2}},
    {receipt: {...iosReceipt, headSha: "d".repeat(40)}},
  ]) {
    const h = harness({...options, files: [{filename: "mobile/app.config.ts"}]})
    // Explicit absence, rather than the default fixture.
    if (options.ios === undefined && "ios" in options)
      h.args.github.rest.actions.listWorkflowRuns = async ({workflow_id}) => ({
        data: {workflow_runs: workflow_id.includes("ios") ? [] : [run]},
      })
    await notifyPrBuilds(h.args)
    assert.match(h.posts[0].text, /incomplete/)
    assert.doesNotMatch(h.written[0].body, /Download iPhone IPA|Download Mac app/)
    assert.match(h.written[0].body, /Download Android APK/)
  }
})

test("Android failure still allows verified iOS links; cancelled iOS suppresses stale post", async () => {
  process.env.ANDROID_RESULT = "failure"
  const h = harness({files: [{filename: "mobile/app.config.ts"}]})
  await notifyPrBuilds(h.args)
  assert.match(h.written[0].body, /Download iPhone IPA/)
  assert.match(h.posts[0].text, /incomplete/)
  process.env.ANDROID_RESULT = "success"
  const cancelled = harness({files: [{filename: "mobile/app.config.ts"}], ios: {...iosRun, conclusion: "cancelled"}})
  await notifyPrBuilds(cancelled.args)
  assert.equal(cancelled.posts.length, 0)
})
