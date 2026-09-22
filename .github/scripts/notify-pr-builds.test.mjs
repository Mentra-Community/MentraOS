import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import {once} from "node:events"
import {createServer} from "node:http"
import test from "node:test"
import {readFileSync} from "node:fs"
import {brotliCompressSync} from "node:zlib"
import {
  iosBuildRequired,
  buildPost,
  matchingBuildRun,
  notifyPrBuilds,
  readOtaTargets,
  verifyIosTextArtifact,
} from "./notify-pr-builds.mjs"

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
test("matching runs require the exact PR head and repository", () => {
  assert.equal(matchingBuildRun([run, {...run, id: 2, head_sha: "other"}], pr, sha), run)
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
const androidRun = {...run, id: 2, html_url: "https://github.com/o/r/actions/runs/2"}
const job = (name, conclusion = "success", attempt = 1, id = attempt) => ({
  name,
  conclusion,
  run_attempt: attempt,
  id,
  status: "completed",
  started_at: new Date(Date.UTC(2026, 8, 18, 0, attempt, 0)).toISOString(),
  completed_at: new Date(Date.UTC(2026, 8, 18, 0, attempt, 10)).toISOString(),
})
function harness(options = {}) {
  const state = {
    android: androidRun,
    asg: run,
    ios: iosRun,
    files: [],
    receipt: iosReceipt,
    comments: [],
    currentPr: pr,
    artifactStatus: 200,
    missingMac: false,
    missingInstall: false,
    wrongInstallType: false,
    corruptInstall: false,
    jobs: {},
    ...options,
  }
  const posts = [],
    written = [],
    requests = []
  const runs = () => [state.asg, state.android, state.ios].filter(Boolean)
  const github = {
    rest: {
      pulls: {get: async () => ({data: state.currentPr}), listFiles: "files"},
      actions: {
        listWorkflowRuns: async ({workflow_id}) => ({
          data: {
            workflow_runs: [
              state[
                workflow_id === "mentra-app-ios-build.yml"
                  ? "ios"
                  : workflow_id === "mentra-app-android-build.yml"
                  ? "android"
                  : "asg"
              ],
            ].filter(Boolean),
          },
        }),
        listJobsForWorkflowRun: "jobs",
      },
      issues: {
        listComments: "comments",
        createComment: async (v) => {
          written.push(v)
          state.comments.push({id: 1, user: {type: "Bot"}, body: v.body})
        },
        updateComment: async (v) => {
          written.push(v)
          state.comments.find((c) => c.id === v.comment_id).body = v.body
        },
      },
    },
    paginate: async (method, args) => {
      if (method === "files") return state.files
      if (method === "comments") return state.comments
      assert.equal(method, "jobs")
      assert.equal(args.filter, "all")
      if (state.jobs[args.run_id]) return state.jobs[args.run_id]
      const source = runs().find((r) => r.id === args.run_id)
      const names = source === state.ios ? ["build", "publish"] : source === state.asg ? ["select", "build"] : ["build"]
      return names.map((name, index) =>
        job(name, index === names.length - 1 ? source.conclusion : "success", source.run_attempt),
      )
    },
  }
  const fetchImpl = async (url, options) => {
    requests.push(url)
    if (options.method === "POST") {
      posts.push(JSON.parse(options.body))
      return new Response("ok")
    }
    const isInstallFile = /\.(html|plist)$/.test(url)
    return new Response(
      options.method === "HEAD"
        ? null
        : isInstallFile
        ? state.corruptInstall
          ? "bad bytes!"
          : "test bytes"
        : JSON.stringify(url.includes("mentra-ios-pr-") ? state.receipt : manifest),
      {
        status:
          (state.missingMac && url.endsWith(".zip")) || (state.missingInstall && url.endsWith(".html"))
            ? 404
            : state.artifactStatus,
        headers: {
          ...(isInstallFile ? {"content-encoding": "br"} : {"content-length": "10"}),
          "content-type": state.wrongInstallType
            ? "application/octet-stream"
            : url.endsWith(".html")
            ? "text/html; charset=utf-8"
            : "text/xml; charset=utf-8",
        },
      },
    )
  }
  return {
    state,
    posts,
    written,
    requests,
    args: {
      github,
      context: {repo: {owner: "o", repo: "r"}, payload: {pull_request: pr}, runId: 2},
      core: {info() {}, warning() {}},
      fetchImpl,
    },
  }
}
process.env.SLACK_WEBHOOK_PR_BUILDS = "https://example.com/webhook"

test("publishes direct iPhone installation and a shareable Safari link without the raw IPA download", async () => {
  const receipt = structuredClone(iosReceipt)
  receipt.schemaVersion = 2
  for (const [kind, ext] of [
    ["install", "html"],
    ["manifest", "plist"],
  ])
    receipt.artifacts[kind] = {
      name: `mentra-ios-${kind}-pr-123-${sha}-3-1.${ext}`,
      size: 10,
      sha256: createHash("sha256").update("test bytes").digest("hex"),
    }
  const ready = harness({files: [{filename: "mobile/app.config.ts"}], receipt})
  await notifyPrBuilds(ready.args)
  const platformBlock = ready.posts[0].blocks[3]
  assert.equal(platformBlock.type, "rich_text")
  const platformRows = platformBlock.elements
  assert.equal(platformRows.length, 3)
  assert.deepEqual(
    platformRows.map((row) => row.elements[1].text),
    [" Android", " iOS", " macOS"],
  )
  assert.ok(platformRows.every((row) => row.type === "rich_text_section" && row.elements[1].style.bold))
  assert.equal(platformRows[0].elements[3].text, "Download APK")
  assert.equal(platformRows[2].elements[3].text, "Download ZIP")
  assert.deepEqual(platformRows.map((row) => row.elements.filter((element) => element.type === "link").length), [1, 2, 1])
  const iphoneLinks = platformRows[1].elements.filter((element) => element.type === "link")
  assert.deepEqual(iphoneLinks.map((element) => element.text), ["Install on iPhone", "Share install link"])
  // A structured link is required: webhook mrkdwn escapes this URL scheme.
  const direct = new URL(iphoneLinks[0].url)
  assert.equal(direct.protocol, "itms-services:")
  assert.equal(direct.searchParams.get("action"), "download-manifest")
  const verifiedManifest = ready.requests.find((url) => url.endsWith(".plist"))
  assert.equal(direct.searchParams.get("url"), verifiedManifest)
  assert.equal(iphoneLinks[1].url, ready.requests.find((url) => url.endsWith(".html")))
  assert.doesNotMatch(JSON.stringify(ready.posts[0]), /Download IPA/)
  assert.match(JSON.stringify(ready.posts[0]), /Install the app, connect your Mentra Live glasses/)
  assert.match(ready.written[0].body, /\[Install on iPhone\]\(https:\/\/artifactscdn.*\.html\)/)
  assert.doesNotMatch(ready.written[0].body, /itms-services:/)
  assert.ok(ready.requests.some((url) => url.endsWith(".plist")))
  assert.ok(ready.requests.some((url) => url.endsWith(".html")))
  for (const failure of [{missingInstall: true}, {wrongInstallType: true}, {corruptInstall: true}]) {
    const incomplete = harness({files: ready.state.files, receipt, ...failure})
    await notifyPrBuilds(incomplete.args)
    assert.match(incomplete.posts[0].text, /incomplete/)
    assert.doesNotMatch(JSON.stringify(incomplete.posts[0]), /Install on iPhone/)
    assert.doesNotMatch(JSON.stringify(incomplete.posts[0]), /itms-services:/)
  }
  const legacy = harness({files: ready.state.files})
  await notifyPrBuilds(legacy.args)
  assert.match(legacy.written[0].body, /Download iPhone IPA/)
  assert.doesNotMatch(legacy.written[0].body, /Install on iPhone/)
  assert.doesNotMatch(JSON.stringify(legacy.posts[0]), /itms-services:/)
})

test("verifies decoded install files through real HTTP compression with missing or compressed Content-Length", async (t) => {
  const body = Buffer.from("<plist>" + "manifest content ".repeat(30) + "</plist>")
  const compressed = brotliCompressSync(body)
  const asset = {size: body.length, sha256: createHash("sha256").update(body).digest("hex")}
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/xml; charset=utf-8")
    response.setHeader("Content-Encoding", "br")
    if (request.url === "/length") response.setHeader("Content-Length", compressed.length)
    response.write(compressed)
    response.end()
  })
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const origin = `http://127.0.0.1:${server.address().port}`
  for (const endpoint of ["/length", "/chunked"]) {
    const response = await fetch(origin + endpoint)
    assert.notEqual(Number(response.headers.get("content-length")), asset.size)
    await verifyIosTextArtifact(response, "manifest", asset)
  }
  await assert.rejects(
    verifyIosTextArtifact(new Response(body, {headers: {"content-type": "text/xml"}}), "manifest", {
      ...asset,
      size: asset.size + 1,
    }),
    /size disagrees/,
  )
  await assert.rejects(
    verifyIosTextArtifact(new Response(body, {headers: {"content-type": "text/xml"}}), "manifest", {
      ...asset,
      sha256: "0".repeat(64),
    }),
    /hash disagrees/,
  )
})

// Exercise the completion route declared by each real caller, not a fictional
// second Android invocation. Actionlint additionally validates workflow syntax,
// reusable-workflow permissions and secret declarations.
async function reconcileFromWorkflow(file, h, sourceId) {
  const workflow = readFileSync(new URL(`../workflows/${file}`, import.meta.url), "utf8")
  const notification = workflow.split("\n  notify-pr-builds:\n")[1]
  assert.ok(notification, `${file} must reconcile after its own completion/retry`)
  assert.match(notification, /if:.*always\(\).*?!cancelled\(\).*?head.repo.full_name == github.repository/)
  assert.match(notification, /uses: \.\/\.github\/workflows\/reusable-pr-build-notification.yml/)
  const dependencies = file.includes("ios") ? "[build, publish]" : file.includes("asg") ? "[select, build]" : "build"
  assert.ok(notification.includes(`needs: ${dependencies}`))
  const shared = readFileSync(new URL("../workflows/reusable-pr-build-notification.yml", import.meta.url), "utf8")
  assert.match(shared, /workflow_call:/)
  assert.match(shared, /queue: max/)
  assert.match(
    shared,
    /concurrency:\s+group: pr-builds-slack-\$\{\{ github.event.pull_request.number \}\}\s+cancel-in-progress: false/,
  )
  assert.match(shared, /await notifyPrBuilds\(\{github, context, core\}\)/)
  await notifyPrBuilds({...h.args, context: {...h.args.context, runId: sourceId}})
}

test("deduplicates completion events and suppresses closed/superseded/cancelled builds", async () => {
  const ready = harness()
  await notifyPrBuilds(ready.args)
  assert.equal(ready.posts.length, 1)
  assert.match(ready.posts[0].text, /ready to test/)
  await notifyPrBuilds(ready.args)
  assert.equal(ready.posts.length, 1)
  for (const currentPr of [
    {...pr, head: {...pr.head, sha: "other"}},
    {...pr, state: "closed"},
  ]) {
    const stale = harness({currentPr})
    await notifyPrBuilds(stale.args)
    assert.equal(stale.posts.length, 0)
  }
  const cancelled = harness({asg: {...run, conclusion: "cancelled"}})
  await notifyPrBuilds(cancelled.args)
  assert.equal(cancelled.posts.length, 0)
})

test("iOS path applicability matches its filtered workflow", () => {
  assert.equal(iosBuildRequired([{filename: "README.md"}]), false)
  for (const filename of [
    "mobile/app.config.ts",
    "asg_client/ota_manifests/firmware_live.json",
    "cloud-v2/core/index.ts",
    ".github/workflows/mentra-app-ios-build.yml",
    ".github/workflows/reusable-pr-build-notification.yml",
    ".github/scripts/pr-ios-artifacts.test.mjs",
  ])
    assert.equal(iosBuildRequired([{filename}]), true)
})

test("pending/missing producers defer to their completion without posting an incomplete result", async () => {
  for (const options of [
    {ios: undefined},
    {ios: {...iosRun, status: "queued"}},
    {jobs: {3: [job("build"), {...job("publish"), status: "in_progress", conclusion: null}]}},
  ]) {
    const h = harness({...options, files: [{filename: "mobile/app.config.ts"}]})
    await reconcileFromWorkflow("mentra-app-android-build.yml", h, 2)
    assert.equal(h.posts.length, 0)
  }
})

test("iOS-only retry refreshes an already-completed incomplete notification without rerunning Android", async () => {
  const h = harness({files: [{filename: "mobile/app.config.ts"}], ios: {...iosRun, conclusion: "failure"}})
  await reconcileFromWorkflow("mentra-app-android-build.yml", h, 2)
  assert.match(h.posts[0].text, /incomplete/)
  assert.doesNotMatch(h.written[0].body, /Download iPhone IPA|Download Mac app/)

  // Only failed iOS publication reruns; successful archive/Android are retained.
  // Its workflow is still in progress because its notification is executing.
  h.state.ios = {...iosRun, run_attempt: 2, status: "in_progress", conclusion: null}
  h.state.jobs[3] = [
    job("build"),
    job("publish", "failure"),
    {...job("build"), id: 22, run_attempt: 2}, // Retained job copied by GitHub.
    job("publish", "success", 2),
  ]
  h.state.receipt = {...iosReceipt, runAttempt: 2, buildAttempt: 1}
  await reconcileFromWorkflow("mentra-app-ios-build.yml", h, 3)
  assert.equal(h.posts.length, 2)
  assert.match(h.posts[1].text, /ready to test/)
  assert.match(h.written[1].body, /Download iPhone IPA/)
  assert.match(h.written[1].body, /Download Mac app/)
  assert.match(h.written[1].body, /actions\/runs\/2/) // Android link must not become iOS's run.
  assert.ok(h.requests.some((url) => url.endsWith(`mentra-ios-pr-123-${sha}-3-2.json`)))
  assert.match(h.written[1].body, /-3-1\.ipa/) // Original build bytes.
  assert.equal(h.state.comments.length, 1)

  await reconcileFromWorkflow("mentra-asg-client-build.yml", h, 1)
  assert.equal(h.posts.length, 2) // Peer completion is serialized and deduplicated.
  // Rerunning only notification increments the workflow attempt, not the receipt.
  h.state.ios = {...h.state.ios, run_attempt: 3}
  h.state.jobs[3].push(
    {...job("build"), id: 32, run_attempt: 3},
    {...job("publish", "success", 2), id: 33, run_attempt: 3},
  )
  await reconcileFromWorkflow("mentra-app-ios-build.yml", h, 3)
  assert.equal(h.posts.length, 2)
})

test("ASG-only recovery and reused ASG completion use the same reconciliation route", async () => {
  const h = harness({asg: {...run, conclusion: "failure"}})
  await reconcileFromWorkflow("mentra-app-android-build.yml", h, 2)
  assert.match(h.posts[0].text, /incomplete/)
  h.state.asg = {...run, run_attempt: 2, status: "in_progress", conclusion: null}
  h.state.jobs[1] = [job("select", "success", 2), job("build", "skipped", 2)]
  await reconcileFromWorkflow("mentra-asg-client-build.yml", h, 1)
  assert.match(h.posts[1].text, /ready to test/)
})

test("a cancelled notification does not invalidate successful producer jobs", async () => {
  const h = harness({
    asg: {...run, conclusion: "cancelled"},
    jobs: {1: [job("select"), job("build", "skipped"), job("notify-pr-builds / reconcile", "cancelled")]},
  })
  await notifyPrBuilds(h.args)
  assert.match(h.posts[0].text, /ready to test/)
})

test("an active producer retry cannot advertise a previous attempt's success", async () => {
  for (const jobs of [
    [job("build"), job("publish")],
    [job("build", "success", 2), job("publish")],
  ]) {
    const h = harness({
      files: [{filename: "mobile/app.config.ts"}],
      ios: {...iosRun, status: "in_progress", conclusion: null, run_attempt: 2},
      jobs: {3: jobs},
    })
    await notifyPrBuilds(h.args)
    assert.equal(h.posts.length, 0)
  }
})

test("iOS failure, missing downloads or stale receipts never advertise Apple downloads as ready", async () => {
  for (const options of [
    {ios: {...iosRun, conclusion: "failure"}},
    {missingMac: true},
    {receipt: {...iosReceipt, runAttempt: 2}},
    {receipt: {...iosReceipt, headSha: "d".repeat(40)}},
  ]) {
    const h = harness({...options, files: [{filename: "mobile/app.config.ts"}]})
    await notifyPrBuilds(h.args)
    assert.match(h.posts[0].text, /incomplete/)
    const platformRows = h.posts[0].blocks[3].elements
    assert.equal(platformRows[1].elements.at(-1).text, "Unavailable")
    assert.equal(platformRows[2].elements.at(-1).text, "Unavailable")
    assert.ok(platformRows.slice(1).every((row) => row.elements.every((element) => element.type !== "link")))
    assert.doesNotMatch(h.written[0].body, /Download iPhone IPA|Download Mac app/)
    assert.match(h.written[0].body, /Download Android APK/)
  }
})

test("Android failure still allows verified iOS links; cancelled iOS suppresses stale post", async () => {
  const h = harness({files: [{filename: "mobile/app.config.ts"}], android: {...androidRun, conclusion: "failure"}})
  await notifyPrBuilds(h.args)
  assert.match(h.written[0].body, /Download iPhone IPA/)
  assert.match(h.posts[0].text, /incomplete/)
  const cancelled = harness({files: [{filename: "mobile/app.config.ts"}], ios: {...iosRun, conclusion: "cancelled"}})
  await notifyPrBuilds(cancelled.args)
  assert.equal(cancelled.posts.length, 0)
})
