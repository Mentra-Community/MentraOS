import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {createHash} from "node:crypto"
import {readFile} from "node:fs/promises"
import test from "node:test"
import {dispatchReadyRequest} from "./dispatch-device-routine.mjs"
import {createRoutineRequest, REQUEST_WORKFLOW} from "./request-e2e-routine.mjs"
import {artifactUrl} from "./release-artifact-storage.mjs"

// The real issuer, replay reader and dispatch gate over synthetic GitHub/CDN responses.
const repository = "Mentra-Community/MentraOS"
const head = "a".repeat(40), base = "b".repeat(40), merge = "c".repeat(40), digest = "d".repeat(64)
const moved = "e".repeat(40), dev = "9".repeat(40)
const url = (name) => artifactUrl(repository, "pr-builds", name)
const otaUrl = url(`ota-pr-4136-${head}.json`)
const receiptUrl = url(`mentra-ios-pr-4136-${head}-100-2.json`)
const job = (name, attempt) => ({id: attempt * 10, name, run_attempt: attempt, status: "completed", conclusion: "success",
  started_at: `2026-09-21T10:0${attempt}:00Z`, completed_at: `2026-09-21T10:0${attempt}:30Z`})
// A fixed entry time keeps the artifact bytes (and so the replay's recorded digest) reproducible.
const zip = (value) => execFileSync("python3", ["-c", [
  "import io,sys,zipfile", "b=io.BytesIO()",
  "z=zipfile.ZipFile(b,'w')", "i=zipfile.ZipInfo('request.json', date_time=(2026, 9, 21, 10, 10, 0))", "i.external_attr=0o600<<16",
  "z.writestr(i, sys.stdin.buffer.read())", "z.close()",
  "sys.stdout.buffer.write(b.getvalue())"].join("\n")], {input: Buffer.from(JSON.stringify(value))})

function fixture() {
  const pr = {number: 4136, state: "open", html_url: `https://github.com/${repository}/pull/4136`,
    head: {sha: head, ref: "codex/day1-ota", repo: {full_name: repository}}, base: {sha: base, ref: "dev"}, labels: []}
  const producer = {id: 100, run_attempt: 2, event: "pull_request", status: "completed", head_sha: head, head_branch: pr.head.ref,
    head_repository: {full_name: repository}, repository: {full_name: repository}, path: ".github/workflows/mentra-app-ios-build.yml",
    html_url: `https://github.com/${repository}/actions/runs/100`}
  const receipt = {schemaVersion: 1, pr: 4136, headSha: head, buildSha: merge, runId: 100, runAttempt: 2, buildAttempt: 1,
    app: {pr: 4136, headSha: head, buildSha: merge, runId: 100, runAttempt: 1, bundleId: "com.mentra.mentra", teamId: "T5XXXL6N36",
      backend: "dev", otaManifestUrl: otaUrl, executableSha256: digest, javascriptSha256: digest, version: "3.2.1", build: "302010030"},
    artifacts: {iphone: {name: `mentra-ios-iphone-pr-4136-${head}-100-1.ipa`, size: 1234, sha256: digest},
      mac: {name: `mentra-ios-mac-pr-4136-${head}-100-1.zip`, size: 1234, sha256: digest}}}
  const manifest = {releaseVersion: `pr-4136-${head}`, apps: {"com.mentra.asg_client": {versionName: "3.2.1", versionCode: 302010030,
    sha256: digest, apkUrl: "https://example.com/asg.apk", apkSize: 123}}, bes_firmware: {version: "26.9.21.1"},
    mtk_full_ota: {end_firmware: "MentraLive_20260915.0"}}
  const requestRun = (id, sha = dev) => ({id, run_attempt: 1, event: "workflow_dispatch", status: "completed", conclusion: "success",
    head_sha: sha, head_branch: "dev", path: REQUEST_WORKFLOW, repository: {full_name: repository}, head_repository: {full_name: repository},
    html_url: `https://github.com/${repository}/actions/runs/${id}`})
  const state = {pr, producer, receipt, manifest, baseSha: base, runs: [producer, requestRun(300)], artifacts: {}, archives: {},
    parents: [{sha: base}, {sha: head}], archiveSize: "1234", prReads: 0, dispatched: []}
  const github = {
    rest: {
      pulls: {get: async () => { state.prReads++; return {data: structuredClone(state.pr)} }},
      git: {getRef: async ({ref}) => ({data: {ref: `refs/${ref}`, object: {type: "commit", sha: state.baseSha}}})},
      actions: {
        listWorkflowRuns: async () => ({data: {workflow_runs: [state.producer]}}),
        getWorkflowRunAttempt: async ({run_id, attempt_number}) => {
          const data = state.runs.find(run => run.id === run_id && run.run_attempt === attempt_number)
          if (!data) throw Object.assign(new Error("Not found"), {status: 404})
          return {data: structuredClone(data)}
        },
        listJobsForWorkflowRun: "jobs", listWorkflowRunArtifacts: "artifacts",
        downloadArtifact: async ({artifact_id}) => ({data: state.archives[artifact_id]}),
      },
      repos: {getCommit: async () => ({data: {sha: merge, parents: state.parents}})},
    },
    paginate: async (method, {run_id}) => method === "jobs" ? [job("build", 1), job("publish", 2)] : state.artifacts[run_id] ?? [],
  }
  const fetchImpl = async (address, options = {}) => {
    if (options.method === "HEAD") return new Response(null, {headers: {"content-length": state.archiveSize}})
    const value = address === otaUrl ? state.manifest : address === receiptUrl ? state.receipt : undefined
    assert.ok(value, `Unexpected metadata URL: ${address}`)
    return new Response(JSON.stringify(value))
  }
  const context = (runId) => ({repo: {owner: "Mentra-Community", repo: "MentraOS"}, runId, eventName: "workflow_dispatch", payload: {}})
  const source = {runAttempt: 1, ref: "refs/heads/dev", sha: dev, workflowSha: dev,
    workflowRef: `${repository}/${REQUEST_WORKFLOW}@refs/heads/dev`, actor: "routine-fixer"}
  const publish = (runId, request) => {
    const bytes = zip(request)
    state.archives[runId * 10] = bytes
    state.artifacts[runId] = [{id: runId * 10, name: `mentra-routine-request-${runId}-1`, expired: false, size_in_bytes: bytes.length,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, workflow_run: {id: runId, head_sha: dev}}]
  }
  // The original: an explicit dev request for the then-current PR head/base.
  const original = () => createRoutineRequest({github, context: context(300), number: 4136, routine: "no-glasses",
    requestOrigin: "workflow-dispatch", source, fetchImpl, now: () => new Date("2026-09-21T10:10:00Z")})
  const replay = (options = {}) => createRoutineRequest({github, context: context(400), number: 4136, routine: "no-glasses",
    requestOrigin: "workflow-dispatch", source, fetchImpl, now: () => new Date("2026-09-27T10:10:00Z"), originalRequestRunId: "300", ...options})
  const privateGithub = {rest: {actions: {createWorkflowDispatch: async (input) => { state.dispatched.push(input) }}}}
  const dispatch = (request) => dispatchReadyRequest({github, privateGithub, context: context(400), fetchImpl,
    plan: {mode: "dispatch", runId: 400, runAttempt: 1, sourceSha: dev}, bytes: Buffer.from(JSON.stringify(request))})
  return {state, github, original, replay, dispatch, publish}
}

async function recorded() {
  const f = fixture(), first = await f.original()
  assert.equal(first.status, "ready")
  f.publish(300, first)
  return {f, first}
}

const changes = {
  head: f => { f.state.pr.head.sha = moved },
  base: f => { f.state.baseSha = moved },
  closed: f => { f.state.pr.state = "closed" },
  merged: f => { Object.assign(f.state.pr, {state: "closed", merged: true, merge_commit_sha: moved}) },
}

for (const [name, change] of Object.entries(changes)) test(`an original PR build replays exactly after its PR ${name === "head" || name === "base" ? `${name} moved` : `was ${name}`}`, async () => {
  const {f, first} = await recorded()
  change(f)
  const reads = f.state.prReads
  const request = await f.replay()
  assert.equal(request.status, "ready", request.reason)
  assert.equal(request.requestId, "routine-400-1-4136-no-glasses")
  assert.deepEqual(request.pullRequest, first.pullRequest)
  assert.deepEqual(request.selection, first.selection)
  assert.deepEqual(request.original, {requestId: first.requestId, runId: 300, runAttempt: 1,
    artifactDigest: f.state.artifacts[300][0].digest.slice(7)})
  assert.equal(request.routine.authorization, "workflow-dispatch")
  assert.equal(f.state.prReads, reads, "the replay never consults the current PR")
  // The dispatch gate re-reads the same original and forwards only the exact replay.
  assert.equal((await f.dispatch(request)).status, "private-job-requested")
  assert.deepEqual(f.state.dispatched.map(input => input.inputs.request_run_id), ["400"])
})

test("a changed receipt, archive, producer run, merge source or backend is never replayed", async () => {
  const cases = {
    receipt: f => { f.state.receipt.app.version = "3.2.2" },
    archive: f => { f.state.archiveSize = "999" },
    run: f => { f.state.producer.head_sha = moved; f.state.runs[0].head_sha = moved },
    source: f => { f.state.parents = [{sha: moved}, {sha: head}] },
    backend: f => { f.state.receipt.app.backend = "staging" },
  }
  for (const [name, change] of Object.entries(cases)) {
    const {f} = await recorded()
    change(f)
    const request = await f.replay()
    assert.equal(request.status, "no-artifact", name)
    assert.equal(request.selection, null, name)
    assert.equal((await f.dispatch(request)).status, "not-dispatched", name)
    // Forging the original selection into it is refused at dispatch after re-reading the build.
    const {first} = await recorded()
    await assert.rejects(f.dispatch({...request, status: "ready", selection: first.selection}), undefined, name)
    assert.deepEqual(f.state.dispatched, [], name)
  }
})

test("only a digest-verified ready original from the trusted dev workflow, for this PR and routine, can be replayed", async () => {
  const cases = {
    digest: (f, first) => { f.state.artifacts[300][0].digest = `sha256:${"0".repeat(64)}` },
    bootstrap: (f) => { Object.assign(f.state.runs[1], {event: "pull_request", head_branch: "codex/day1-ota"}) },
    failed: (f) => { f.state.runs[1].conclusion = "failure" },
    routine: (f, first) => { f.publish(300, {...first, requestId: "routine-300-1-4136-day1-ota", routine: {...first.routine, id: "day1-ota"}}) },
    notReady: (f, first) => { f.publish(300, {...first, status: "no-artifact", selection: null}) },
    chained: (f, first) => { f.publish(300, {...first, original: {requestId: "routine-1-1-4136-no-glasses", runId: 1, runAttempt: 1, artifactDigest: digest}}) },
    missing: (f) => { f.state.artifacts[300] = [] },
  }
  for (const [name, change] of Object.entries(cases)) {
    const {f, first} = await recorded()
    change(f, first)
    await assert.rejects(f.replay(), undefined, name)
  }
  const {f} = await recorded()
  for (const options of [{requestOrigin: "pr-label"}, {sourceBuildRunId: "100", sourcePublicationAttempt: "2"},
    {channel: "dev"}, {originalRequestRunId: "abc"}]) await assert.rejects(f.replay(options))
})

test("a replay whose PR identity, selection or original marker differs from the re-read original is not dispatched", async () => {
  const cases = {
    pr: request => { request.pullRequest.headSha = moved; request.selection.build.headSha = moved },
    selection: request => { request.selection.archive.sha256 = "0".repeat(64) },
    digest: request => { request.original.artifactDigest = "0".repeat(64) },
    marker: request => { request.original.requestId = "routine-301-1-4136-no-glasses" },
    authorization: request => { request.routine.authorization = "pr-label" },
  }
  for (const [name, change] of Object.entries(cases)) {
    const {f} = await recorded()
    const request = await f.replay()
    change(request)
    await assert.rejects(f.dispatch(request), undefined, name)
    assert.deepEqual(f.state.dispatched, [], name)
  }
  // An ordinary request is still gated by the current open PR head and base.
  const {f, first} = await recorded()
  f.state.pr.state = "closed"
  f.publish(400, first)
  assert.equal((await f.dispatch({...first, requestId: "routine-400-1-4136-no-glasses",
    trigger: {...first.trigger, runId: 400}})).status, "not-dispatched")
})

test("the shared public/private replay wire fixture is the actual issuer output", async () => {
  // The private validator consumes these exact bytes: the original request, its immutable artifact, and the replay.
  const {f, first} = await recorded()
  changes.merged(f)
  const replay = await f.replay()
  const produced = JSON.parse(JSON.stringify({original: first, originalArtifactBase64: f.state.archives[3000].toString("base64"), replay}))
  assert.deepEqual(JSON.parse(await readFile(new URL("./fixtures/original-replay-requests.json", import.meta.url))), produced)
})
