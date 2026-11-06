import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import {once} from "node:events"
import {createServer} from "node:http"
import test from "node:test"
import {readFileSync} from "node:fs"
import {brotliCompressSync} from "node:zlib"
import {iosInstallationFiles} from "./pr-ios-artifacts-install.mjs"
import {
  iosBuildRequired,
  buildPost,
  matchingBuildRun,
  NO_BUILD_RUN_NAME,
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
  // A newer label change that requests no build is never the build.
  assert.equal(matchingBuildRun([run, {...run, id: 3, display_title: NO_BUILD_RUN_NAME}], pr, sha), run)
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
  // Only a receipt-verified backend is named; the live PR base alone is not evidence.
  assert.match(body, /Backend: not verified/)
  const post = (options) => JSON.stringify(buildPost({pr: {...pr, base: {ref: "staging"}}, sha, androidUrl: "https://example.com/a.apk",
    manifestUrl: "https://example.com/m.json", targets: readOtaTargets(manifest, 123, sha), androidRunUrl: run.html_url, ...options}).blocks)
  assert.match(post({}), /feature → staging/)
  assert.match(post({}), /Backend: not verified/)
  assert.match(post({backend: "staging"}), /Backend: \*Staging\* · Android ARM64/)
  assert.match(post({backend: "staging", unverifiedBackend: ["Android"]}), /Backend: \*Staging\* \(Android not verified\)/)
  assert.match(post({backend: "dev"}), /Backend: \*Dev\*/)
})

const iosRun = {...run, id: 3}
const iosReceipt = {
  schemaVersion: 1,
  pr: 123,
  headSha: sha,
  buildSha: "b".repeat(40),
  runId: 3,
  runAttempt: 1,
  app: {backend: "dev"},
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
// Every Android PR publication commits this receipt beside its APK.
const androidReceipt = (backend = "dev", digest = "e".repeat(64)) => ({schemaVersion: 1, pr: 123, headSha: sha,
  baseSha: "b".repeat(40), buildSha: "c".repeat(40), runId: 2, runAttempt: 1,
  app: {packageId: "com.mentra.mentra", version: "3.3.0", build: "303000123", headSha: sha, buildSha: "c".repeat(40), backend,
    otaManifestUrl: `https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/pr-builds/ota-pr-123-${sha}.json`},
  artifacts: {android: {name: `mentra-android-pr-123-${sha}-2-1.apk`, sha256: digest, size: 10}}})
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
    androidReceipt: androidReceipt(),
    comments: [],
    currentPr: pr,
    artifactStatus: 200,
    missingMac: false,
    missingInstall: false,
    missingUrls: [],
    lengths: {},
    wrongInstallType: false,
    corruptInstall: false,
    textArtifacts: {},
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
        listWorkflowRuns: async ({workflow_id}) => {
          return {
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
          }
        },
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
    if (url.endsWith("/api/internal/routine-catalog")) {
      assert.fail("PR notification must not request the routine catalog")
    }
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
            : (state.textArtifacts[url.endsWith(".html") ? "install" : "manifest"] ?? "test bytes")
          : JSON.stringify(url.includes("mentra-ios-pr-") ? state.receipt
            : url.includes("mentra-android-pr-") ? state.androidReceipt : manifest),
      {
        status:
          (state.missingMac && url.endsWith(".zip")) || (state.missingInstall && url.endsWith(".html")) ||
          state.missingUrls.includes(url)
            ? 404
            : state.artifactStatus,
        headers: {
          ...(isInstallFile ? {"content-encoding": "br"} : {"content-length": state.lengths[url] ?? "10"}),
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
  assert.deepEqual(
    platformRows.map((row) => row.elements.filter((element) => element.type === "link").length),
    [1, 2, 1],
  )
  const iphoneLinks = platformRows[1].elements.filter((element) => element.type === "link")
  assert.deepEqual(
    iphoneLinks.map((element) => element.text),
    ["Install on iPhone", "Share install link"],
  )
  // A structured link is required: webhook mrkdwn escapes this URL scheme.
  const direct = new URL(iphoneLinks[0].url)
  assert.equal(direct.protocol, "itms-services:")
  assert.equal(direct.searchParams.get("action"), "download-manifest")
  const verifiedManifest = ready.requests.find((url) => url.endsWith(".plist"))
  assert.equal(direct.searchParams.get("url"), verifiedManifest)
  assert.equal(
    iphoneLinks[1].url,
    ready.requests.find((url) => url.endsWith(".html")),
  )
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

test("advertises HTTPS Mac handoff only from a verified capable page and uses the publication attempt", async () => {
  const receipt = structuredClone(iosReceipt)
  Object.assign(receipt, {
    schemaVersion: 2,
    runAttempt: 2,
    buildAttempt: 1,
    app: {
      bundleId: "com.mentra.mentra",
      version: "3.2.1",
      build: "302018377",
      backend: "dev",
      macPackageVersion: 2,
      macInstaller: "Install Mentra.app",
    },
    macInstaller: {
      bundleId: "com.mentra.mac-installer",
      teamId: "T5XXXL6N36",
      notarizationStatus: "Accepted",
      notarizationId: "12345678-abcd-1234-abcd-123456789012",
      stapled: true,
    },
  })
  const files = iosInstallationFiles(receipt, "o/r")
  const textArtifacts = {}
  for (const [kind, file] of Object.entries(files)) {
    textArtifacts[kind] = file.content
    receipt.artifacts[kind] = {
      name: file.name,
      size: Buffer.byteLength(file.content),
      sha256: createHash("sha256").update(file.content).digest("hex"),
    }
  }
  const ready = harness({
    files: [{filename: "mobile/app.config.ts"}],
    receipt,
    textArtifacts,
    ios: {...iosRun, run_attempt: 2},
  })
  await notifyPrBuilds(ready.args)
  const macLinks = ready.posts[0].blocks[3].elements[2].elements.filter((item) => item.type === "link")
  assert.deepEqual(
    macLinks.map((item) => item.text),
    ["Install on Mac", "First-time setup ZIP"],
  )
  const handoff = new URL(macLinks[0].url)
  assert.equal(handoff.protocol, "https:")
  assert.equal(handoff.search, "?platform=mac&attempt=2")
  assert.match(handoff.pathname, /-3-1\.html$/)
  assert.match(macLinks[1].url, /-3-1\.zip$/)
  assert.doesNotMatch(JSON.stringify(ready.posts[0]), /mentra-install:/)
  assert.match(ready.written[0].body, /\[Install on Mac\]\(https:[^)]*platform=mac&attempt=2\)/)
  assert.equal(ready.requests.filter((url) => url.endsWith(".html")).length, 1)

  const corrupted = harness({...ready.state, comments: [], corruptInstall: true})
  await notifyPrBuilds(corrupted.args)
  assert.doesNotMatch(JSON.stringify(corrupted.posts[0]), /Install on Mac/)
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
  for (const filename of ["README.md", "cloud-v2/packages/core/src/service.ts", "cloud-v2/websites/admin/src/page.tsx",
    "cloud-v2/packages/runtime/src/server.ts", "cloud-v2/packages/cloud-client/node/index.ts"])
    assert.equal(iosBuildRequired([{filename}]), false)
  for (const filename of [
    "cloud-v2/bun.lock",
    "mobile/app.config.ts",
    "asg_client/ota_manifests/firmware_live.json",
    "cloud-v2/packages/cloud-client/src/client.ts",
    "cloud-v2/packages/cloud-client/react-native/transports.ts",
    "cloud-v2/packages/protocol/src/index.ts",
    "cloud-v2/packages/runtime/src/protocol/index.ts",
    ".github/workflows/mentra-app-ios-build.yml",
    ".github/workflows/reusable-pr-build-notification.yml",
    ".github/scripts/pr-ios-artifacts.test.mjs",
    ".github/scripts/pr-android-artifacts.mjs",
    ".github/scripts/pr-android-artifacts.test.mjs",
    ".github/scripts/ensure-android-ndk.mjs",
    ".github/scripts/ios-xcodebuild-attempt.sh",
    ".github/actions/disk-guard/action.yml",
  ])
    assert.equal(iosBuildRequired([{filename}]), true)
})

test("the monorepo maps its layout to MentraOS's paths, and every bundled miniapp requires iOS", () => {
  const monorepo = "Mentra-Community/Mentra"
  for (const filename of ["public/mentraos/mobile/src/app.tsx", "mentra_live/asg_client/app/build.gradle",
    "miniapps/public/captions/src/index.ts", ".github/workflows/mentra-app-ios-build.yml",
    "public/mentraos/.github/scripts/pr-ios-artifacts.mjs", "mentra_live/bes/src/main.c", ".github/workflows/bes.yml",
    ".github/ci/pack-miniapps.sh", ".github/ci/bundled-miniapps.sh", ".github/ci/asg-build-identity.mjs",
    "testing/routines/example.md", "public/mentraos/sdk/miniapp-cli/src/pack.ts", "public/mentraos/cloud-v2/packages/auth/src/index.ts",
    "public/mentraos/cloud-v2/packages/miniapp-tools/src/index.ts", "public/mentraos/cloud-v2/packages/protocol/tsconfig.json",
    "public/mentraos/cloud-v2/tsconfig.base.json"])
    assert.equal(iosBuildRequired([{filename}], monorepo), true, filename)
  for (const filename of ["public/mentraos/README.md", "internal_tools/app.ts",
    "public/mentraos/cloud-v2/packages/core/src/service.ts"])
    assert.equal(iosBuildRequired([{filename}], monorepo), false, filename)
  // MentraOS keeps its own layout.
  assert.equal(iosBuildRequired([{filename: "miniapps/public/captions/src/index.ts"}], "Mentra-Community/MentraOS"), false)
  assert.equal(iosBuildRequired([{filename: "public/mentraos/mobile/src/app.tsx"}], "Mentra-Community/MentraOS"), false)
})

test("an Android artifact-helper-only PR reports its triggered iOS build, including a failure", async () => {
  const files = [{filename: ".github/scripts/pr-android-artifacts.mjs"}]
  const ready = harness({files})
  await notifyPrBuilds(ready.args)
  assert.match(ready.written[0].body, /Download iPhone IPA/)
  assert.ok(ready.requests.some(url => url.includes("mentra-ios-pr-")))
  const failed = harness({files, ios: {...iosRun, conclusion: "failure"}})
  await notifyPrBuilds(failed.args)
  assert.match(failed.posts[0].text, /incomplete/)
  assert.match(JSON.stringify(failed.posts[0]), /iOS failure; downloads are not ready/)
  assert.match(failed.written[0].body, /iOS failure; downloads are not ready/)
  assert.doesNotMatch(failed.written[0].body, /not built for these changed paths/)
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

test("a last-callback Android receipt miss publishes all downloads and later verifies them once", async () => {
  const h = harness({files: [{filename: "mobile/app.config.ts"}]})
  const original = h.args.fetchImpl, digest = "e".repeat(64)
  let available = false, reads = 0
  h.args.fetchImpl = async (url, options) => {
    if (!url.includes("mentra-android-pr-") || !url.endsWith(".json")) return original(url, options)
    reads++
    if (!available) return new Response("temporarily unavailable", {status: 404})
    return new Response(JSON.stringify({schemaVersion: 1, pr: 123, headSha: sha, baseSha: "b".repeat(40), buildSha: "c".repeat(40), runId: 2, runAttempt: 1,
      app: {packageId: "com.mentra.mentra", version: "3.3.0", build: "303000123", headSha: sha, buildSha: "c".repeat(40), backend: "dev",
        otaManifestUrl: `https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/pr-builds/ota-pr-123-${sha}.json`},
      artifacts: {android: {name: `mentra-android-pr-123-${sha}-2-1.apk`, sha256: digest, size: 10}}}))
  }
  await notifyPrBuilds(h.args)
  assert.equal(reads, 1); assert.equal(h.posts.length, 1); assert.equal(h.written.length, 1)
  assert.ok(h.written[0].body.includes("Download Android APK"))
  assert.ok(h.written[0].body.includes("Download iPhone IPA"))
  assert.ok(h.written[0].body.includes("Download Mac app"))
  assert.match(h.written[0].body, /:android-receipt-unavailable -->/)
  await notifyPrBuilds(h.args)
  assert.equal(reads, 2); assert.equal(h.posts.length, 1); assert.equal(h.written.length, 1)
  available = true
  await notifyPrBuilds(h.args)
  assert.equal(reads, 3); assert.equal(h.posts.length, 2); assert.equal(h.written.length, 2)
  assert.ok(h.written[1].body.includes(digest))
  await notifyPrBuilds(h.args)
  assert.equal(reads, 4); assert.equal(h.posts.length, 2); assert.equal(h.written.length, 2)
  available = false
  await notifyPrBuilds(h.args)
  assert.equal(reads, 5); assert.equal(h.posts.length, 2); assert.equal(h.written.length, 2)
  available = true
  await notifyPrBuilds(h.args)
  assert.equal(reads, 6); assert.equal(h.posts.length, 2); assert.equal(h.written.length, 2)
  h.state.missingMac = true
  await notifyPrBuilds(h.args)
  assert.equal(h.posts.length, 3); assert.match(h.posts[2].text, /incomplete/)
  assert.ok(h.written[2].body.includes(digest))
  h.state.missingMac = false
  available = false
  // Readiness changed during the miss: publish the Mac download without reusing the
  // earlier verified Android identity, so the recovered receipt can enrich it once.
  await notifyPrBuilds(h.args)
  assert.equal(h.posts.length, 4); assert.doesNotMatch(h.posts[3].text, /incomplete/)
  assert.ok(!h.written[3].body.includes(digest)); assert.ok(h.written[3].body.includes("Download Mac app"))
  assert.match(h.written[3].body, /:android-receipt-unavailable -->/)
  await notifyPrBuilds(h.args)
  assert.equal(h.posts.length, 4); assert.equal(h.written.length, 4)
  available = true
  await notifyPrBuilds(h.args)
  assert.equal(h.posts.length, 5); assert.doesNotMatch(h.posts[4].text, /incomplete/)
  assert.ok(h.written[4].body.includes(digest))
  await notifyPrBuilds(h.args)
  assert.equal(h.posts.length, 5); assert.equal(h.written.length, 5)
})

const slack = (post) => post.blocks.flatMap(block => block.text?.text ?? []).join("\n")
const links = (post) => JSON.stringify(post.blocks[3])

const cdn = "https://artifactscdn.mentraglass.com/o/r/releases/pr-builds"
const immutableApk = `${cdn}/mentra-android-pr-123-${sha}-2-1.apk`
const bothLinks = (h, index) => `${links(h.posts[index])}\n${h.written[index].body}`

test("a verified post links the receipt's immutable APK and binds its hash", async () => {
  const h = harness({files: [{filename: "mobile/app.config.ts"}]})
  await notifyPrBuilds(h.args)
  assert.match(slack(h.posts[0]), /Backend: \*Dev\* · Android ARM64/)
  assert.doesNotMatch(h.posts[0].text, /incomplete/)
  assert.ok(bothLinks(h, 0).includes(immutableApk))
  assert.doesNotMatch(bothLinks(h, 0), /mobile-pr-/)
  assert.match(h.written[0].body, new RegExp(`^<!-- ${sha}:ready:2-1:1-1:3-1:android-${"e".repeat(64)} -->$`, "m"))
  await notifyPrBuilds(h.args)
  assert.equal(h.posts.length, 1)
})

test("a missing or wrong immutable APK after a verified receipt is incomplete", async () => {
  for (const failure of [{missingUrls: [immutableApk]}, {lengths: {[immutableApk]: "11"}}]) {
    const h = harness({files: [{filename: "mobile/app.config.ts"}], ...failure})
    await notifyPrBuilds(h.args)
    assert.match(h.posts[0].text, /incomplete/)
    assert.doesNotMatch(slack(h.posts[0]), /Backend: \*Dev\* · Android ARM64/)
    assert.doesNotMatch(links(h.posts[0]), /Download APK/)
    assert.doesNotMatch(h.written[0].body, /Download Android APK/)
    assert.doesNotMatch(h.written[0].body, /:android-/)
  }
})

test("a later head's receipt reusing an earlier publication links that publication's downloads", async () => {
  const earlier = "f".repeat(40)
  const original = androidReceipt()
  const reused = {...original, runId: 2, runAttempt: 1, reusedFrom: {headSha: earlier, runId: 9, runAttempt: 1},
    app: {...original.app, headSha: earlier,
      otaManifestUrl: `https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/pr-builds/ota-pr-123-${earlier}.json`},
    artifacts: {android: {...original.artifacts.android, name: `mentra-android-pr-123-${earlier}-9-1.apk`}}}
  const receipt = structuredClone(iosReceipt)
  receipt.schemaVersion = 2
  receipt.app = {backend: "dev", headSha: earlier, macPackageVersion: 1,
    otaManifestUrl: `https://artifactscdn.mentraglass.com/Mentra-Community/Mentra/releases/pr-builds/ota-pr-123-${earlier}.json`}
  receipt.reusedFrom = {headSha: earlier, runId: 8, runAttempt: 3, buildAttempt: 2}
  for (const [kind, ext] of [["iphone", "ipa"], ["mac", "zip"], ["install", "html"], ["manifest", "plist"]])
    receipt.artifacts[kind] = {name: `mentra-ios-${kind}-pr-123-${earlier}-8-2.${ext}`, size: 10, sha256: "c".repeat(64)}
  const page = '<section data-mentra-mac-install="1">'
  receipt.artifacts.install = {name: receipt.artifacts.install.name, size: Buffer.byteLength(page),
    sha256: createHash("sha256").update(page).digest("hex")}
  receipt.artifacts.manifest = {name: receipt.artifacts.manifest.name, size: 10,
    sha256: createHash("sha256").update("test bytes").digest("hex")}
  const h = harness({files: [{filename: "mobile/app.config.ts"}], androidReceipt: reused, receipt,
    textArtifacts: {install: page}})
  await notifyPrBuilds(h.args)
  assert.doesNotMatch(h.posts[0].text, /incomplete/)
  assert.ok(bothLinks(h, 0).includes(`${cdn}/mentra-android-pr-123-${earlier}-9-1.apk`))
  assert.ok(h.written[0].body.includes(`${cdn}/mentra-ios-mac-pr-123-${earlier}-8-2.zip`))
  // The earlier page opens the earlier receipt, attempt 3.
  assert.ok(h.written[0].body.includes(`${cdn}/mentra-ios-install-pr-123-${earlier}-8-2.html?platform=mac&attempt=3`))
  assert.match(h.written[0].body, new RegExp(`^<!-- ${sha}:ready:2-1:1-1:3-1:android-${"e".repeat(64)} -->$`, "m"))
})

test("a transient receipt miss never downgrades an already verified post", async () => {
  const h = harness({files: [{filename: "mobile/app.config.ts"}]})
  await notifyPrBuilds(h.args)
  h.state.androidReceipt = {unavailable: true}
  await notifyPrBuilds(h.args)
  h.state.androidReceipt = androidReceipt()
  await notifyPrBuilds(h.args)
  assert.equal(h.posts.length, 1)
  assert.equal(h.written.length, 1)
  // Readiness may still advance during the miss, without claiming a verified Android backend.
  h.state.androidReceipt = {unavailable: true}
  h.state.missingMac = true
  await notifyPrBuilds(h.args)
  assert.equal(h.posts.length, 2)
  assert.match(h.posts[1].text, /incomplete/)
  assert.match(slack(h.posts[1]), /Backend: not verified/)
  assert.ok(bothLinks(h, 1).includes(immutableApk))
  // The changed-readiness fallback does not inherit the earlier verified identity.
  assert.match(h.written[1].body, new RegExp(`^<!-- ${sha}:incomplete:2-1:1-1:3-1:android-receipt-unavailable -->$`, "m"))
  // The receipt returns while the Mac download is still missing: enrich once, then stay quiet.
  h.state.androidReceipt = androidReceipt()
  await notifyPrBuilds(h.args)
  await notifyPrBuilds(h.args)
  assert.equal(h.posts.length, 3)
  assert.equal(h.written.length, 3)
  assert.match(h.posts[2].text, /incomplete/)
  assert.match(slack(h.posts[2]), /Backend: \*Dev\* · Android ARM64/)
  assert.ok(bothLinks(h, 2).includes(immutableApk))
  assert.match(h.written[2].body, new RegExp(`^<!-- ${sha}:incomplete:2-1:1-1:3-1:android-${"e".repeat(64)} -->$`, "m"))
})

test("an initially missing receipt enriches the post once with the verified immutable APK", async () => {
  const h = harness({files: [{filename: "mobile/app.config.ts"}], androidReceipt: {unavailable: true}})
  await notifyPrBuilds(h.args)
  await notifyPrBuilds(h.args)
  assert.equal(h.posts.length, 1)
  assert.match(slack(h.posts[0]), /Android not verified/)
  assert.ok(bothLinks(h, 0).includes(immutableApk))
  h.state.androidReceipt = androidReceipt()
  await notifyPrBuilds(h.args)
  await notifyPrBuilds(h.args)
  assert.equal(h.posts.length, 2)
  assert.equal(h.written.length, 2)
  assert.match(slack(h.posts[1]), /Backend: \*Dev\* · Android ARM64/)
  assert.ok(bothLinks(h, 1).includes(immutableApk))
})

test("a same-head retarget never relabels retained builds for the new destination", async () => {
  const staging = {...pr, base: {ref: "staging"}}
  const h = harness({files: [{filename: "mobile/app.config.ts"}], currentPr: staging})
  await notifyPrBuilds(h.args)
  assert.equal(h.posts.length, 1)
  assert.match(h.posts[0].text, /incomplete/)
  const text = slack(h.posts[0])
  assert.match(text, /Android was built for the Dev backend, but this PR now targets staging/)
  assert.match(text, /iOS \/ macOS was built for the Dev backend, but this PR now targets staging/)
  assert.doesNotMatch(text, /Backend:|Glasses OTA/)
  assert.doesNotMatch(links(h.posts[0]), /Download APK|Install on|Download ZIP/)
  assert.doesNotMatch(h.written[0].body, /Download Android APK|Download iPhone IPA|Download Mac app/)
  await notifyPrBuilds(h.args)
  assert.equal(h.posts.length, 1)

  // Rebuilt publications for the new destination are verified and labelled from their receipts.
  const rebuilt = harness({files: [{filename: "mobile/app.config.ts"}], currentPr: staging,
    androidReceipt: androidReceipt("staging"), receipt: {...iosReceipt, app: {backend: "staging"}}})
  await notifyPrBuilds(rebuilt.args)
  assert.doesNotMatch(rebuilt.posts[0].text, /incomplete/)
  assert.match(slack(rebuilt.posts[0]), /Backend: \*Staging\* · Android ARM64/)
  assert.match(links(rebuilt.posts[0]), /Download APK/)
})

test("platforms completing separately are each checked against the same destination", async () => {
  // Android was rebuilt after the retarget; the retained Apple publication was not.
  const h = harness({files: [{filename: "mobile/app.config.ts"}], currentPr: {...pr, base: {ref: "staging"}},
    androidReceipt: androidReceipt("staging")})
  await notifyPrBuilds(h.args)
  assert.match(h.posts[0].text, /incomplete/)
  const text = slack(h.posts[0])
  assert.match(text, /Backend: \*Staging\* · Android ARM64/)
  assert.match(text, /iOS \/ macOS was built for the Dev backend/)
  assert.match(links(h.posts[0]), /Download APK/)
  assert.doesNotMatch(links(h.posts[0]), /Install on|Download ZIP/)
})

test("a retarget while notifying suppresses the post", async () => {
  const h = harness({files: [{filename: "mobile/app.config.ts"}]})
  let reads = 0
  h.args.github.rest.pulls.get = async () => ({data: reads++ ? {...pr, base: {ref: "staging"}} : pr})
  await notifyPrBuilds(h.args)
  assert.ok(reads >= 2)
  assert.equal(h.posts.length, 0)
  assert.equal(h.written.length, 0)
})

test("an unavailable Android receipt keeps downloads but does not claim their backend", async () => {
  const h = harness({files: [{filename: "mobile/app.config.ts"}], androidReceipt: {unavailable: true}})
  await notifyPrBuilds(h.args)
  assert.match(slack(h.posts[0]), /Backend: \*Dev\* \(Android not verified\)/)
  assert.match(links(h.posts[0]), /Download APK/)
  assert.match(h.written[0].body, /:android-receipt-unavailable -->/)
  const androidOnly = harness({androidReceipt: {unavailable: true}})
  await notifyPrBuilds(androidOnly.args)
  assert.match(slack(androidOnly.posts[0]), /Backend: not verified/)
  // Once the receipt verifies, the post is refreshed with its verified backend.
  h.state.androidReceipt = androidReceipt()
  await notifyPrBuilds(h.args)
  assert.equal(h.posts.length, 2)
  assert.match(slack(h.posts[1]), /Backend: \*Dev\* · Android ARM64/)
})

for (const filename of [".github/scripts/ios-xcodebuild-attempt.sh", ".github/actions/disk-guard/action.yml"]) {
  test(`${filename}-only PR waits for Apple publication and includes all downloads`, async () => {
    const h = harness({files: [{filename}],
      jobs: {3: [job("build"), {...job("publish"), status: "in_progress", conclusion: null}]}})
    await reconcileFromWorkflow("mentra-app-android-build.yml", h, 2)
    assert.equal(h.posts.length, 0)
    h.state.jobs = {}
    await reconcileFromWorkflow("mentra-app-ios-build.yml", h, 3)
    assert.equal(h.posts.length, 1)
    assert.match(h.written[0].body, /Download Android APK/)
    assert.match(h.written[0].body, /Download iPhone IPA/)
    assert.match(h.written[0].body, /Download Mac app/)
  })
}

test("a staging PR with a missing Android receipt stays idempotent", async () => {
  const h = harness({files: [{filename: "mobile/app.config.ts"}], androidReceipt: {unavailable: true},
    currentPr: {...pr, base: {ref: "staging"}},
    receipt: {...iosReceipt, app: {backend: "staging"}}})
  await notifyPrBuilds(h.args)
  const text = slack(h.posts[0])
  assert.doesNotMatch(h.posts[0].text, /incomplete/)
  assert.match(text, /Backend: \*Staging\* \(Android not verified\)/)
  assert.match(links(h.posts[0]), /Download APK/)
  await notifyPrBuilds(h.args)
  assert.equal(h.posts.length, 1)
  assert.equal(h.written.length, 1)
})
