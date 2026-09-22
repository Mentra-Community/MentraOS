import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import test from "node:test"
import {
  createRoutineRequest,
  REQUEST_LABEL,
  REQUEST_WORKFLOW,
  successfulMacPublication,
} from "./request-e2e-routine.mjs"
import {artifactUrl} from "./release-artifact-storage.mjs"

const repository = "Mentra-Community/MentraOS"
const head = "a".repeat(40)
const base = "b".repeat(40)
const merge = "c".repeat(40)
const digest = "d".repeat(64)
const url = (name) => artifactUrl(repository, "pr-builds", name)
const otaUrl = url(`ota-pr-4136-${head}.json`)
const job = (name, attempt = 1) => ({
  id: attempt * 10,
  name,
  run_attempt: attempt,
  status: "completed",
  conclusion: "success",
  started_at: `2026-09-21T10:0${attempt}:00Z`,
  completed_at: `2026-09-21T10:0${attempt}:30Z`,
})

function fixture() {
  const pr = {
    number: 4136,
    state: "open",
    html_url: `https://github.com/${repository}/pull/4136`,
    head: {sha: head, ref: "codex/day1-ota", repo: {full_name: repository}},
    base: {sha: base, ref: "dev"},
    labels: [{name: REQUEST_LABEL}],
  }
  const run = {
    id: 100,
    run_attempt: 2,
    event: "pull_request",
    status: "completed",
    head_sha: head,
    head_branch: pr.head.ref,
    head_repository: pr.head.repo,
    path: ".github/workflows/mentra-app-ios-build.yml",
    html_url: `https://github.com/${repository}/actions/runs/100`,
  }
  const receipt = {
    schemaVersion: 1,
    pr: pr.number,
    headSha: head,
    buildSha: merge,
    runId: run.id,
    runAttempt: 2,
    buildAttempt: 1,
    app: {
      pr: pr.number,
      headSha: head,
      buildSha: merge,
      runId: run.id,
      runAttempt: 1,
      bundleId: "com.mentra.mentra",
      teamId: "T5XXXL6N36",
      backend: "dev",
      otaManifestUrl: otaUrl,
      executableSha256: digest,
      javascriptSha256: digest,
      version: "3.2.1",
      build: "302010030",
    },
    artifacts: Object.fromEntries(
      [
        ["iphone", "ipa"],
        ["mac", "zip"],
      ].map(([kind, ext]) => [
        kind,
        {name: `mentra-ios-${kind}-pr-4136-${head}-100-1.${ext}`, size: 1234, sha256: digest},
      ]),
    ),
  }
  const manifest = {
    releaseVersion: `pr-4136-${head}`,
    apps: {
      "com.mentra.asg_client": {
        versionName: "3.2.1",
        versionCode: 302010030,
        sha256: digest,
        apkUrl: "https://example.com/asg.apk",
        apkSize: 123,
      },
    },
    bes_firmware: {version: "26.9.21.1"},
    mtk_full_ota: {end_firmware: "MentraLive_20260915.0"},
  }
  const state = {
    pr,
    receipt,
    manifest,
    runs: [run],
    jobs: [job("build"), job("publish", 2)],
    parents: [{sha: base}, {sha: head}],
    missingArchive: false,
    prReads: 0,
    changeOnReread: false,
  }
  const github = {
    rest: {
      pulls: {
        get: async () => ({
          data: state.changeOnReread && state.prReads++ > 0 ? {...pr, head: {...pr.head, sha: "f".repeat(40)}} : pr,
        }),
      },
      actions: {listWorkflowRuns: async () => ({data: {workflow_runs: state.runs}}), listJobsForWorkflowRun: () => {}},
      repos: {getCommit: async () => ({data: {sha: merge, parents: state.parents}})},
    },
    paginate: async () => state.jobs,
  }
  const source = {
    runAttempt: 1,
    ref: "refs/pull/4136/merge",
    sha: merge,
    workflowSha: merge,
    workflowRef: `${repository}/${REQUEST_WORKFLOW}@refs/pull/4136/merge`,
    actor: "tester",
  }
  const context = {
    repo: {owner: "Mentra-Community", repo: "MentraOS"},
    runId: 200,
    eventName: "pull_request",
    payload: {pull_request: structuredClone(pr)},
  }
  const fetchImpl = async (address, options) => {
    if (options.method === "HEAD")
      return new Response(null, {status: state.missingArchive ? 404 : 200, headers: {"content-length": "1234"}})
    assert.ok(address === otaUrl || address === url(`mentra-ios-pr-4136-${head}-100-2.json`))
    return new Response(JSON.stringify(address === otaUrl ? state.manifest : state.receipt))
  }
  const resolve = () =>
    createRoutineRequest({
      github,
      context,
      number: 4136,
      source,
      fetchImpl,
      now: () => new Date("2026-09-21T10:10:00Z"),
    })
  return {state, context, source, resolve}
}

test("freezes original build attempt, retained publication and exact raw manifest hash", async () => {
  const f = fixture()
  const request = await f.resolve()
  assert.equal(request.status, "ready")
  assert.equal(request.requestId, "routine-200-1-4136-day1-ota")
  assert.deepEqual(request.selection.build, {headSha: head, baseSha: base, buildSha: merge})
  assert.equal(request.selection.producer.buildAttempt, 1)
  assert.equal(request.selection.producer.publicationAttempt, 2)
  assert.equal(
    request.selection.otaManifest.sha256,
    createHash("sha256").update(JSON.stringify(f.state.manifest)).digest("hex"),
  )
  assert.equal(request.trigger.workflowSha, merge)
  assert.match(request.reason, /has not run/)
})

test("wrong-head runs, missing archives and stale merge bases never become ready", async () => {
  for (const breakCandidate of [
    (state) => {
      state.runs[0].head_sha = "f".repeat(40)
    },
    (state) => {
      state.missingArchive = true
    },
    (state) => {
      state.parents[0].sha = "f".repeat(40)
    },
    (state) => {
      state.receipt.app.otaManifestUrl = "https://example.com/wrong.json"
    },
    (state) => {
      state.receipt.app.headSha = "f".repeat(40)
    },
    (state) => {
      state.manifest.releaseVersion = "old"
    },
    (state) => {
      state.jobs[1].conclusion = "failure"
    },
  ]) {
    const f = fixture()
    breakCandidate(f.state)
    const request = await f.resolve()
    assert.equal(request.status, "no-artifact")
    assert.equal(request.selection, null)
  }
})

test("a removed bootstrap label, obsolete triggering event or concurrent PR push does not queue", async () => {
  for (const change of [
    (f) => {
      f.state.pr.labels = []
    },
    (f) => {
      f.context.payload.pull_request.head.sha = "f".repeat(40)
    },
    (f) => {
      f.state.changeOnReread = true
    },
  ]) {
    const f = fixture()
    change(f)
    const request = await f.resolve()
    assert.equal(request.status, "no-artifact")
    assert.equal(request.selection, null)
  }
})

test("manual requests execute only from dev and bootstrap uses the PR merge ref", async () => {
  const f = fixture()
  f.context.eventName = "workflow_dispatch"
  await assert.rejects(f.resolve(), /trusted dev/)
  f.source.ref = "refs/heads/dev"
  f.source.workflowRef = `${repository}/${REQUEST_WORKFLOW}@refs/heads/dev`
  assert.equal((await f.resolve()).status, "ready")
  f.context.eventName = "pull_request"
  await assert.rejects(f.resolve(), /merge checkout/)
})

test("cloned successful jobs retain original attempts but an active/new failed build is not stale success", () => {
  const build = job("build")
  const publish = job("publish", 2)
  const jobs = [build, publish, {...build, id: 40, run_attempt: 3}, {...publish, id: 41, run_attempt: 3}]
  assert.deepEqual(successfulMacPublication({run_attempt: 3, status: "completed"}, jobs), {
    buildAttempt: 1,
    publicationAttempt: 2,
  })
  assert.equal(successfulMacPublication({run_attempt: 4, status: "in_progress"}, jobs), null)
  assert.equal(
    successfulMacPublication({run_attempt: 4, status: "completed"}, [
      ...jobs,
      {...job("build", 4), conclusion: "failure"},
    ]),
    null,
  )
})
