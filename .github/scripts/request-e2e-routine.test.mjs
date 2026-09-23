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
    repository: {full_name: repository},
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
    runAttempts: [run],
    apiCalls: [],
    receipts: {},
    jobs: [job("build"), job("publish", 2)],
    parents: [{sha: base}, {sha: head}],
    missingArchive: false,
    prReads: 0,
    changeOnReread: false,
    removeLabelOnReread: false,
    baseRef: {ref: "refs/heads/dev", object: {type: "commit", sha: base}},
    baseReads: 0,
    changeBaseOnReread: false,
  }
  const github = {
    rest: {
      pulls: {
        get: async () => {
          const data = structuredClone(pr)
          if (state.prReads++ > 0) {
            if (state.changeOnReread) data.head.sha = "f".repeat(40)
            if (state.removeLabelOnReread) data.labels = []
          }
          return {data}
        },
      },
      git: {
        getRef: async ({ref}) => {
          assert.equal(ref, "heads/dev")
          const data = structuredClone(state.baseRef)
          if (state.changeBaseOnReread && state.baseReads > 0) data.object.sha = "e".repeat(40)
          state.baseReads++
          return {data}
        },
      },
      actions: {
        listWorkflowRuns: async () => {
          state.apiCalls.push(["list"])
          return {data: {workflow_runs: state.runs}}
        },
        getWorkflowRunAttempt: async (input) => {
          state.apiCalls.push(["attempt", input])
          const data = state.runAttempts.find((run) => run.id === input.run_id && run.run_attempt === input.attempt_number)
          if (!data) throw Object.assign(new Error("Not found"), {status: 404})
          return {data}
        },
        listJobsForWorkflowRun: () => {},
      },
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
    const value = address === otaUrl ? state.manifest :
      state.receipts[address] ?? (address === url(`mentra-ios-pr-4136-${head}-100-2.json`) ? state.receipt : undefined)
    assert.ok(value, `Unexpected metadata URL: ${address}`)
    return new Response(JSON.stringify(value))
  }
  const resolve = (options = {}) =>
    createRoutineRequest({
      github,
      context,
      number: 4136,
      source,
      fetchImpl,
      now: () => new Date("2026-09-21T10:10:00Z"),
      ...options,
    })
  const manual = () => {
    context.eventName = "workflow_dispatch"
    source.ref = "refs/heads/dev"
    source.workflowRef = `${repository}/${REQUEST_WORKFLOW}@refs/heads/dev`
  }
  return {state, context, source, github, resolve, manual}
}

const originalPublication = {sourceBuildRunId: "100", sourcePublicationAttempt: "2", requestOrigin: "pr-label"}

test("delayed automatic requests keep the original run while manual requests select the newer build", async () => {
  const f = fixture()
  f.manual()
  const newer = {...f.state.runs[0], id: 101, html_url: `https://github.com/${repository}/actions/runs/101`}
  f.state.runs.unshift(newer)
  const receipt = structuredClone(f.state.receipt)
  receipt.runId = receipt.app.runId = newer.id
  for (const artifact of Object.values(receipt.artifacts)) artifact.name = artifact.name.replace("-100-", "-101-")
  f.state.receipts[url(`mentra-ios-pr-4136-${head}-101-2.json`)] = receipt
  const selected = await f.resolve(originalPublication)
  assert.equal(selected.status, "ready")
  assert.equal(selected.selection.producer.runId, 100)
  assert.deepEqual(f.state.apiCalls, [["attempt", {
    owner: "Mentra-Community", repo: "MentraOS", run_id: 100, attempt_number: 2,
  }]])
  const manual = await f.resolve({sourceBuildRunId: "", sourcePublicationAttempt: ""})
  assert.equal(manual.status, "ready")
  assert.equal(manual.selection.producer.runId, 101)
})

test("separate callbacks for old and new publication attempts resolve separate exact receipts", async () => {
  const f = fixture()
  f.manual()
  const newer = {...f.state.runs[0], run_attempt: 3}
  f.state.runs[0] = newer
  f.state.runAttempts.push(newer)
  f.state.jobs.push(job("publish", 3))
  f.state.receipts[url(`mentra-ios-pr-4136-${head}-100-3.json`)] = {...f.state.receipt, runAttempt: 3}
  const oldRequest = await f.resolve(originalPublication)
  f.context.runId++
  const newRequest = await f.resolve({...originalPublication, sourcePublicationAttempt: "3"})
  assert.equal(oldRequest.status, "ready")
  assert.equal(newRequest.status, "ready")
  assert.equal(oldRequest.selection.producer.publicationAttempt, 2)
  assert.equal(newRequest.selection.producer.publicationAttempt, 3)
  assert.notEqual(oldRequest.selection.receipt.url, newRequest.selection.receipt.url)
  assert.notEqual(oldRequest.requestId, newRequest.requestId)
})

test("missing, mismatching or no-longer-eligible exact sources never fall back to a newer run", async () => {
  for (const change of [
    (f) => { f.state.runAttempts = [] },
    (f) => { f.state.runs[0].path = ".github/workflows/other.yml" },
    (f) => { f.state.runs[0].head_sha = "f".repeat(40) },
    (f) => { f.state.runs[0].head_branch = "other" },
    (f) => { f.state.runs[0].head_repository = {full_name: "fork/repo"} },
    (f) => { f.state.runs[0].repository = {full_name: "fork/repo"} },
    (f) => { f.state.runs[0].status = "in_progress" },
    (f) => { f.state.jobs[1].conclusion = "failure" },
    (f) => { f.state.parents[0].sha = "f".repeat(40) },
    (f) => { f.state.changeOnReread = true },
    (f) => { f.state.changeBaseOnReread = true },
    (f) => { f.state.pr.labels = [] },
    (f) => { f.state.removeLabelOnReread = true },
  ]) {
    const f = fixture()
    f.manual()
    change(f)
    const request = await f.resolve(originalPublication)
    assert.equal(request.status, "no-artifact")
    assert.equal(request.selection, null)
    assert.equal(f.state.apiCalls.some(([kind]) => kind === "list"), false)
  }
  for (const mismatch of [{id: 101}, {run_attempt: 3}]) {
    const f = fixture()
    f.manual()
    f.github.rest.actions.getWorkflowRunAttempt = async () => ({data: {...f.state.runs[0], ...mismatch}})
    assert.equal((await f.resolve(originalPublication)).status, "no-artifact")
  }
})

test("a selected notification-only attempt cannot substitute its retained earlier publication", async () => {
  const f = fixture()
  f.manual()
  const original = job("publish", 1)
  f.state.jobs = [job("build"), original, {...original, id: 21, run_attempt: 2}]
  const request = await f.resolve(originalPublication)
  assert.equal(request.status, "no-artifact")
  assert.equal(request.selection, null)
  assert.match(request.reason, /retained another publication/)
})

test("partial or malformed optional selectors fail before reading PR or build metadata", async () => {
  for (const [sourceBuildRunId, sourcePublicationAttempt] of [
    [undefined, "2"], ["100", undefined], ["", "2"], ["100", ""], [null, null],
    ["1e2", "2"], [" 100", "2"], ["0100", "2"], ["100", "2.0"], ["100", "0"],
    [0, 2], [100, 1.5], [true, 2], ["9007199254740992", "2"],
  ]) {
    const f = fixture()
    f.manual()
    await assert.rejects(() => f.resolve({sourceBuildRunId, sourcePublicationAttempt}), /both be positive safe integers/)
    assert.equal(f.state.prReads, 0)
    assert.deepEqual(f.state.apiCalls, [])
  }
  const bootstrap = fixture()
  await assert.rejects(() => bootstrap.resolve(originalPublication), /selectors require/)
})

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
  assert.equal(request.routine.authorization, "pr-label")
  assert.match(request.reason, /has not run/)
})

for (const routine of ["no-glasses", "mentra-call"]) test(`trusted explicit ${routine} requests need no label with latest or exact publication selection`, async () => {
  for (const selection of [{}, {sourceBuildRunId: "100", sourcePublicationAttempt: "2"}]) {
    const f = fixture()
    f.manual()
    f.state.pr.labels = []
    const request = await f.resolve({routine, ...selection})
    assert.equal(request.status, "ready")
    assert.equal(request.requestId, `routine-200-1-4136-${routine}`)
    assert.equal(request.routine.authorization, "workflow-dispatch")
    assert.deepEqual(request.selection.build, {headSha: head, baseSha: base, buildSha: merge})
    assert.equal(request.selection.archive.sha256, digest)
  }
})

for (const routine of ["no-glasses", "mentra-call"]) test(`automatic ${routine} requests require their own current label before and after selection`, async () => {
  for (const [labels, removed, ready] of [
    [[{name: `routine:${routine}`}], false, true], [[{name: REQUEST_LABEL}], false, false],
    [[{name: `routine:${routine}`}], true, false], [[], false, false],
  ]) {
    const f = fixture()
    f.manual()
    f.state.pr.labels = labels
    f.state.removeLabelOnReread = removed
    const request = await f.resolve({...originalPublication, routine})
    assert.equal(request.status, ready ? "ready" : "no-artifact")
    assert.equal(request.routine.authorization, "pr-label")
    assert.ok(request.routine.reason.includes(`routine:${routine}`))
  }
})

test("explicit opt-in cannot weaken artifact/current-PR checks or originate from PR code", async () => {
  for (const change of [f => {f.state.pr.state = "closed"}, f => {f.state.changeOnReread = true},
    f => {f.state.changeBaseOnReread = true}, f => {f.state.missingArchive = true},
    f => {f.state.receipt.app.executableSha256 = "invalid"}]) {
    const f = fixture()
    f.manual()
    f.state.pr.labels = []
    change(f)
    assert.equal((await f.resolve({routine: "no-glasses", requestOrigin: "workflow-dispatch"})).status, "no-artifact")
  }
  for (const options of [{routine: "arbitrary-script"}, {requestOrigin: "unknown"}, {requestOrigin: true},
    {requestOrigin: "workflow-dispatch"}]) {
    const f = fixture()
    await assert.rejects(() => f.resolve(options))
    assert.equal(f.state.prReads, 0)
  }
})

test("stale PR API and event base SHAs do not replace the actual dev tip", async () => {
  const f = fixture()
  f.state.pr.base.sha = "e".repeat(40)
  f.context.payload.pull_request.base.sha = "f".repeat(40)
  const request = await f.resolve()
  assert.equal(request.status, "ready")
  assert.equal(request.pullRequest.baseSha, base)
  assert.equal(request.selection.build.baseSha, base)
  assert.equal(f.state.baseReads, 2)
})

test("a stale actual dev tip or a concurrent base update never selects an old merge", async () => {
  const stale = fixture()
  stale.state.baseRef.object.sha = "e".repeat(40)
  const staleRequest = await stale.resolve()
  assert.equal(staleRequest.status, "no-artifact")
  assert.equal(staleRequest.pullRequest.baseSha, "e".repeat(40))
  assert.equal(staleRequest.selection, null)
  assert.match(staleRequest.reason, /current base/)
  const changed = fixture()
  changed.state.changeBaseOnReread = true
  const changedRequest = await changed.resolve()
  assert.equal(changedRequest.status, "no-artifact")
  assert.equal(changedRequest.selection, null)
  assert.match(changedRequest.reason, /changed while resolving/)
})

test("invalid branch ref identity fails closed instead of falling back to PR base metadata", async () => {
  for (const change of [
    (state) => {
      state.baseRef.ref = "refs/heads/staging"
    },
    (state) => {
      state.baseRef.object.type = "tag"
    },
    (state) => {
      state.baseRef.object.sha = "invalid"
    },
  ]) {
    const f = fixture()
    change(f.state)
    await assert.rejects(f.resolve(), /invalid dev branch ref/)
  }
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
