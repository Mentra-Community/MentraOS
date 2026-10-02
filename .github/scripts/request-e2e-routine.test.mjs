import {ANDROID_PUBLICATION_STEP} from "./pr-android-artifacts.mjs"
import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import {readFile} from "node:fs/promises"
import test from "node:test"
import {
  createRoutineRequest,
  REQUEST_LABEL,
  REQUEST_WORKFLOW,
  successfulMacPublication,
  successfulAndroidPublication,
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
    retargetOnReread: false,
    refReads: [],
  }
  const github = {
    rest: {
      pulls: {
        get: async () => {
          const data = structuredClone(pr)
          if (state.prReads++ > 0) {
            if (state.changeOnReread) data.head.sha = "f".repeat(40)
            if (state.removeLabelOnReread) data.labels = []
            if (state.retargetOnReread) data.base.ref = data.base.ref === "dev" ? "staging" : "dev"
          }
          return {data}
        },
      },
      git: {
        getRef: async ({ref}) => {
          state.refReads.push(ref)
          assert.equal(ref, `heads/${pr.base.ref}`)
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
  // A staging-targeted PR still resolves on the trusted dev issuer.
  const staging = () => {
    for (const target of [pr, context.payload.pull_request]) target.base.ref = "staging"
    state.baseRef.ref = "refs/heads/staging"
    receipt.app.backend = "staging"
  }
  return {state, context, source, github, resolve, manual, staging}
}

const originalPublication = {sourceBuildRunId: "100", sourcePublicationAttempt: "2", requestOrigin: "pr-label"}

test("the shared private/public PR wire fixture is the actual producer output", async () => {
  // The private harness projects each request's authenticated failure source from these exact bytes.
  const label = fixture(), manual = fixture(), stagingLabel = fixture()
  label.manual()
  manual.manual()
  manual.state.pr.labels = []
  stagingLabel.staging()
  stagingLabel.manual()
  const produced = JSON.parse(JSON.stringify({
    bootstrap: await fixture().resolve(),
    labelCallback: await label.resolve(originalPublication),
    manual: await manual.resolve({routine: "no-glasses", requestOrigin: "workflow-dispatch"}),
    stagingLabelCallback: await stagingLabel.resolve(originalPublication),
  }))
  for (const [name, kind, authorization] of [["bootstrap", "pull_request", "pr-label"],
    ["labelCallback", "workflow_dispatch", "pr-label"], ["manual", "workflow_dispatch", "workflow-dispatch"],
    ["stagingLabelCallback", "workflow_dispatch", "pr-label"]]) {
    assert.equal(produced[name].status, "ready")
    assert.equal(produced[name].trigger.kind, kind)
    assert.equal(produced[name].routine.authorization, authorization)
  }
  assert.deepEqual(JSON.parse(await readFile(new URL("./fixtures/pr-routine-requests.json", import.meta.url))), produced)
})

test("dev and staging PRs share the trusted dev issuer and bind their exact current base and backend", async () => {
  for (const destination of ["dev", "staging"]) {
    for (const options of [{}, originalPublication, {routine: "no-glasses", requestOrigin: "workflow-dispatch"}]) {
      const f = fixture()
      if (destination === "staging") f.staging()
      f.manual()
      if (options.requestOrigin === "workflow-dispatch") f.state.pr.labels = []
      const request = await f.resolve(options)
      assert.equal(request.status, "ready", request.reason)
      assert.equal(request.schemaVersion, 1)
      assert.equal(request.trigger.ref, "refs/heads/dev")
      assert.equal(request.trigger.workflowRef, `${repository}/${REQUEST_WORKFLOW}@refs/heads/dev`)
      assert.equal(request.pullRequest.baseRef, destination)
      assert.equal(request.pullRequest.baseSha, base)
      assert.equal(request.selection.app.backend, destination)
      assert.deepEqual(request.selection.build, {headSha: head, baseSha: base, buildSha: merge})
      assert.deepEqual(f.state.refReads, [`heads/${destination}`, `heads/${destination}`])
    }
  }
})

test("a staging PR bootstrap label uses its PR merge checkout and exact staging tip", async () => {
  const f = fixture()
  f.staging()
  const request = await f.resolve()
  assert.equal(request.status, "ready", request.reason)
  assert.equal(request.trigger.ref, "refs/pull/4136/merge")
  assert.equal(request.pullRequest.baseRef, "staging")
})

test("backend mismatches, retargets, stale bases and other destinations never become ready", async () => {
  for (const [setup, reason] of [
    [f => { f.staging(); f.state.receipt.app.backend = "dev" }, /backend differs/],
    [f => { f.state.receipt.app.backend = "staging" }, /backend differs/],
    [f => { f.staging(); f.state.receipt.app.backend = "prod" }, /disagrees/],
    [f => { f.staging(); f.state.retargetOnReread = true }, /changed while resolving/],
    [f => { f.state.retargetOnReread = true }, /changed while resolving/],
    [f => { f.staging(); f.state.changeBaseOnReread = true }, /changed while resolving/],
    [f => { f.staging(); f.state.baseRef.object.sha = "e".repeat(40) }, /current base/],
    [f => { f.staging(); f.context.payload.pull_request.base.ref = "dev" }, /superseded/],
  ]) {
    for (const trusted of [false, true]) {
      const f = fixture()
      setup(f)
      if (trusted) f.manual()
      if (trusted && reason.source === "superseded") continue
      const request = await f.resolve(trusted ? originalPublication : {})
      assert.equal(request.status, "no-artifact")
      assert.equal(request.selection, null)
      assert.match(request.reason, reason)
    }
  }
  for (const other of ["main", "feature"]) {
    const f = fixture()
    f.manual()
    f.state.pr.base.ref = other
    const request = await f.resolve(originalPublication)
    assert.equal(request.status, "no-artifact")
    assert.match(request.reason, /targeting dev or staging/)
    assert.equal(request.pullRequest.baseRef, other)
    assert.deepEqual(f.state.refReads, [])
    assert.equal(f.state.apiCalls.length, 0)
  }
})

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

for (const routine of ["no-glasses", "mentra-call", "captions-phone", "notes-phone", "livestreamer", "account-miniapps"]) test(`trusted explicit ${routine} requests need no label with latest or exact publication selection`, async () => {
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

for (const routine of ["no-glasses", "mentra-call", "captions-phone", "notes-phone", "livestreamer", "account-miniapps"]) test(`automatic ${routine} requests require their own current label before and after selection`, async () => {
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

test("the workflow admits and selects exactly the registered routine labels; planned labels stay out", async () => {
  const {DEVICE_ROUTINES, isRegisteredRoutine} = await import("./device-routines.mjs")
  const workflow = await readFile(new URL("../workflows/request-e2e-routine.yml", import.meta.url), "utf8")
  const admission = workflow.split("\n  request:\n")[1]?.split("\n    runs-on:")[0]
  const chain = workflow.split("REQUEST_ROUTINE: ")[1]?.split("\n")[0]
  assert.ok(admission && chain)
  const labels = text => [...text.matchAll(/'routine:([a-z0-9-]+)'/g)].map(match => match[1]).sort()
  const registered = Object.keys(DEVICE_ROUTINES).filter(id => isRegisteredRoutine(id) && !["ota-roundtrip-android", "open-close-miniapps"].includes(id)).sort()
  assert.deepEqual(labels(admission), registered)
  // mentra-call is the chain's final default rather than a label test.
  assert.deepEqual(labels(chain), registered.filter(id => id !== "mentra-call"))
  assert.match(chain, /\|\| 'mentra-call'\) \}\}$/)
  assert.ok(["livestreamer", "connected-glasses", "account-miniapps"].every(id => registered.includes(id)))
  // Every catalogued routine is registered, but nightly-only routines have no PR-label routing.
  for (const id of ["ota-roundtrip-android", "open-close-miniapps"]) {
    assert.equal(labels(admission).includes(id), false)
    assert.equal(labels(chain).includes(id), false)
  }
  assert.deepEqual(Object.keys(DEVICE_ROUTINES).filter(id => !isRegisteredRoutine(id)), [])
})

test("planned routines refuse PR requests, labelled or explicit, with their pending reason", async () => {
  const {DEVICE_ROUTINES, isRegisteredRoutine} = await import("./device-routines.mjs")
  // Every catalogued routine is registered now; a synthetic planned model of the former planned routines keeps the refusal.
  assert.deepEqual(Object.keys(DEVICE_ROUTINES).filter(id => !isRegisteredRoutine(id)), [])
  const routineCatalog = {...DEVICE_ROUTINES, ...Object.fromEntries(["account-miniapps", "connected-glasses", "livestreamer"].map(id =>
    [id, {...DEVICE_ROUTINES[id], pending: "Synthetic planned model"}]))}
  for (const routine of ["account-miniapps", "connected-glasses", "livestreamer"]) for (const manual of [false, true]) {
    const f = fixture()
    if (manual) f.manual()
    f.state.pr.labels = [{name: `routine:${routine}`}]
    await assert.rejects(f.resolve({routine, routineCatalog}), /planned but not registered/)
  }
  // An unknown routine ID is refused directly, labelled or explicit.
  for (const manual of [false, true]) {
    const f = fixture()
    if (manual) f.manual()
    f.state.pr.labels = [{name: "routine:synthetic-unregistered"}]
    await assert.rejects(f.resolve({routine: "synthetic-unregistered"}), /Unsupported device routine/)
  }
})

test("registered account-miniapps requests bind the exact selected Mac build and backend, on dev and staging", async () => {
  const account = (destination, options = {}) => {
    const f = fixture()
    if (destination === "staging") f.staging()
    f.manual()
    f.state.pr.labels = [{name: "routine:account-miniapps"}]
    return {f, resolve: () => f.resolve({...originalPublication, routine: "account-miniapps", ...options})}
  }
  for (const destination of ["dev", "staging"]) {
    for (const options of [{}, {requestOrigin: "workflow-dispatch"}]) {
      const {f, resolve} = account(destination, options)
      if (options.requestOrigin) f.state.pr.labels = []
      const request = await resolve()
      assert.equal(request.status, "ready", request.reason)
      assert.equal(request.routine.id, "account-miniapps")
      assert.equal(request.routine.authorization, options.requestOrigin ?? "pr-label")
      assert.equal(request.requestId, "routine-200-1-4136-account-miniapps")
      assert.equal(request.selection.platform, "ios-on-mac")
      assert.equal(request.pullRequest.baseRef, destination)
      assert.equal(request.selection.app.backend, destination)
      assert.deepEqual(request.selection.app, f.state.receipt.app)
      assert.deepEqual(request.selection.build, {headSha: head, baseSha: base, buildSha: merge})
      assert.deepEqual([request.selection.producer.buildAttempt, request.selection.producer.publicationAttempt], [1, 2])
      assert.equal(request.selection.archive.sha256, digest)
      assert.equal(request.selection.otaManifest.sha256,
        createHash("sha256").update(JSON.stringify(f.state.manifest)).digest("hex"))
    }
  }
  // The Mac route's own backend, identity, artifact and label checks apply unchanged.
  for (const [destination, change, reason] of [
    ["staging", f => { f.state.receipt.app.backend = "dev" }, /backend differs/],
    ["dev", f => { f.state.receipt.app.backend = "staging" }, /backend differs/],
    ["dev", f => { f.state.receipt.app.executableSha256 = "invalid" }, /identity or its packaged OTA pin disagrees/],
    ["staging", f => { f.state.missingArchive = true }, /archive is missing/],
    ["dev", f => { f.state.removeLabelOnReread = true }, /changed while resolving/],
    ["staging", f => { f.state.pr.labels = [{name: "routine:no-glasses"}] }, /opt-in was removed/],
    ["dev", f => { f.state.baseRef.object.sha = "e".repeat(40) }, /current base/]]) {
    const {f, resolve} = account(destination)
    change(f)
    const request = await resolve()
    assert.equal(request.status, "no-artifact")
    assert.equal(request.selection, null)
    assert.match(request.reason, reason)
  }
  // An Android publication never provides the Mac routine's archive.
  const android = androidFixture(); android.manual(); android.state.pr.labels = [{name: "routine:account-miniapps"}]
  const fromApk = await android.resolve({...originalPublication, routine: "account-miniapps"})
  assert.equal(fromApk.status, "no-artifact")
  assert.match(fromApk.reason, /Unexpected Mac producer identity/)
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


function androidFixture() {
  const f = fixture(), run = f.state.runs[0]
  run.path = ".github/workflows/mentra-app-android-build.yml"
  f.state.pr.labels = [{name: "routine:no-glasses-android"}]
  f.state.jobs = [{...job("build", 2), steps: [{name: ANDROID_PUBLICATION_STEP, status: "completed", conclusion: "success"}]}]
  const receipt = {schemaVersion: 1, pr: 4136, headSha: head, baseSha: base, buildSha: merge, runId: 100, runAttempt: 2,
    app: {packageId: "com.mentra.mentra", version: "3.3.0", build: "303000123", headSha: head, buildSha: merge,
      backend: "dev", otaManifestUrl: otaUrl}, artifacts: {android: {name: `mentra-android-pr-4136-${head}-100-2.apk`,
      sha256: digest, size: 1234}}}
  f.state.receipts[url(`mentra-android-pr-4136-${head}-100-2.json`)] = receipt
  return {...f, android: receipt, resolveAndroid: overrides => f.resolve({routine: "no-glasses-android", ...overrides})}
}

test("Android requests select the exact APK receipt, version and merge without a Mac publication", async () => {
  const f = androidFixture()
  const request = await f.resolveAndroid()
  assert.equal(request.status, "ready", request.reason)
  assert.equal(request.selection.platform, "android")
  assert.equal(request.selection.producer.workflow, f.state.runs[0].path)
  assert.deepEqual(request.selection.producer.buildAttempt, 2)
  assert.deepEqual(request.selection.app, f.android.app)
  assert.equal(request.selection.archive.name, f.android.artifacts.android.name)
  f.manual()
  assert.equal((await f.resolveAndroid({...originalPublication})).status, "ready")
})

test("staging Android requests select only a staging APK for the current staging tip", async () => {
  const f = androidFixture()
  f.staging()
  f.android.app.backend = "staging"
  const request = await f.resolveAndroid()
  assert.equal(request.status, "ready", request.reason)
  assert.equal(request.pullRequest.baseRef, "staging")
  assert.equal(request.selection.app.backend, "staging")
  for (const change of [g => { g.android.app.backend = "dev" }, g => { g.android.baseSha = head }]) {
    const g = androidFixture()
    g.staging()
    g.android.app.backend = "staging"
    change(g)
    assert.equal((await g.resolveAndroid()).status, "no-artifact")
  }
})

test("Android rejects missing publication steps, mismatching APK identity and stale bases", async () => {
  for (const change of [f => f.state.jobs[0].steps = [], f => f.state.jobs[0].steps[0].conclusion = "failure",
    f => f.android.runAttempt++, f => f.android.app.packageId += ".other", f => f.android.baseSha = head,
    f => f.android.app.otaManifestUrl += "old", f => f.state.parents.reverse(), f => f.state.missingArchive = true,
    f => f.state.runs[0].path = ".github/workflows/mentra-app-ios-build.yml", f => f.state.removeLabelOnReread = true]) {
    const f = androidFixture(); change(f)
    assert.equal((await f.resolveAndroid()).status, "no-artifact")
  }
})

test("registered connected-glasses requests select the exact Android APK under their own label, on dev and staging", async () => {
  const connected = f => { f.state.pr.labels = [{name: "routine:connected-glasses"}]; return overrides => f.resolve({routine: "connected-glasses", ...overrides}) }
  for (const channel of ["dev", "staging"]) {
    const f = androidFixture()
    if (channel === "staging") { f.staging(); f.android.app.backend = "staging" }
    const request = await connected(f)()
    assert.equal(request.status, "ready", request.reason)
    assert.equal(request.routine.id, "connected-glasses")
    assert.equal(request.routine.authorization, "pr-label")
    assert.ok(request.routine.reason.includes("routine:connected-glasses"))
    assert.match(request.requestId, /-connected-glasses$/)
    assert.equal(request.selection.platform, "android")
    assert.equal(request.selection.producer.workflow, f.state.runs[0].path)
    assert.deepEqual(request.selection.app, f.android.app)
    assert.equal(request.selection.archive.name, f.android.artifacts.android.name)
    assert.equal(request.pullRequest.baseRef, channel)
  }
  // An explicit trusted request needs no label; an automatic one needs this routine's own current label.
  for (const selection of [{}, {sourceBuildRunId: "100", sourcePublicationAttempt: "2"}]) {
    const manual = androidFixture(); manual.manual(); manual.state.pr.labels = []
    const explicit = await manual.resolve({routine: "connected-glasses", ...selection})
    assert.equal(explicit.status, "ready", explicit.reason)
    assert.equal(explicit.routine.authorization, "workflow-dispatch")
    assert.equal(explicit.selection.archive.name, manual.android.artifacts.android.name)
  }
  for (const labels of [[{name: "routine:no-glasses-android"}], [{name: REQUEST_LABEL}], []]) {
    const f = androidFixture(); f.manual(); f.state.pr.labels = labels
    assert.equal((await f.resolve({routine: "connected-glasses", ...originalPublication})).status, "no-artifact")
  }
  // The exact APK identity, publication, backend and producer checks are the Android route's own.
  for (const change of [f => f.android.app.packageId += ".other", f => f.android.runAttempt++, f => f.android.app.otaManifestUrl += "old",
    f => f.state.jobs[0].steps = [], f => f.state.missingArchive = true, f => f.state.removeLabelOnReread = true,
    f => f.state.runs[0].path = ".github/workflows/mentra-app-ios-build.yml"]) {
    const f = androidFixture(); change(f)
    assert.equal((await connected(f)()).status, "no-artifact")
  }
  const wrongBackend = androidFixture(); wrongBackend.staging(); wrongBackend.android.app.backend = "dev"
  assert.equal((await connected(wrongBackend)()).status, "no-artifact")
})

test("Android retained build jobs select the first publication attempt and a failed newest build is not reused", () => {
  const first = {...job("build"), steps: [{name: ANDROID_PUBLICATION_STEP, status: "completed", conclusion: "success"}]}
  const retained = {...first, id: 30, run_attempt: 2}
  assert.deepEqual(successfulAndroidPublication({run_attempt: 2, status: "completed"}, [first, retained]),
    {buildAttempt: 1, publicationAttempt: 1})
  assert.equal(successfulAndroidPublication({run_attempt: 2, status: "completed"}, [first, {...retained, conclusion: "failure"}]), null)
})


test("nightly-only Android routines reject explicit PR selection and replay before reading GitHub metadata", async () => {
  for (const routine of ["ota-roundtrip-android", "open-close-miniapps"]) for (const base of ["dev", "staging"]) {
    const f = androidFixture()
    f.manual()
    f.state.pr.base.ref = base
    for (const override of [{}, {originalRequestRunId: "123"}]) {
      await assert.rejects(f.resolveAndroid({channel: "pr", routine, requestOrigin: "workflow-dispatch", ...override}),
        /requires a dev independent nightly/)
      assert.equal(f.state.prReads, 0)
      assert.deepEqual(f.state.apiCalls, [])
    }
  }
})
