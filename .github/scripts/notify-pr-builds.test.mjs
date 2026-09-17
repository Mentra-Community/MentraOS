import assert from "node:assert/strict"
import test from "node:test"
import {buildPost, matchingAsgRun, notifyPrBuilds, readOtaTargets} from "./notify-pr-builds.mjs"

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

function harness({asg = run, comments = [], currentPr = pr, artifactStatus = 200} = {}) {
  const posts = [],
    written = []
  const github = {
    rest: {
      pulls: {get: async () => ({data: currentPr})},
      actions: {listWorkflowRuns: async () => ({data: {workflow_runs: [asg]}})},
      issues: {
        listComments: {},
        createComment: async (v) => written.push(v),
        updateComment: async (v) => written.push(v),
      },
    },
    paginate: async () => comments,
  }
  const fetchImpl = async (url, options) => {
    if (options.method === "POST") {
      posts.push(JSON.parse(options.body))
      return new Response("ok")
    }
    return new Response(options.method === "HEAD" ? null : JSON.stringify(manifest), {status: artifactStatus})
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
