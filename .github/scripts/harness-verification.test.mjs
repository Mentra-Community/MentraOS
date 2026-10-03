import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {createHash} from "node:crypto"
import test from "node:test"
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {dispatchReadyRequest, planDeviceDispatch} from "./dispatch-device-routine.mjs"
import {harnessVerificationArtifact, harnessVerificationConstraint, harnessVerificationName,
  HARNESS_VERIFICATION_STEP, readHarnessVerification, validateHarnessVerification} from "./harness-verification.mjs"

const repository = "Mentra-Community/MentraOS", repo = {owner: "Mentra-Community", repo: "MentraOS"}
const source = "a".repeat(40), privateSha = "b".repeat(40), appSha = "c".repeat(40)
const run = {id: 123, run_attempt: 2, path: ".github/workflows/request-e2e-routine.yml", event: "workflow_dispatch",
  head_sha: source, head_branch: "dev", status: "completed", conclusion: "success",
  repository: {full_name: repository}, head_repository: {full_name: repository}}
const context = {eventName: "workflow_run", repo, payload: {workflow_run: {id: 123, run_attempt: 2}}}
const request = {schemaVersion: 1, kind: "mentra-routine-request", status: "ready", requestId: "routine-123-2-42-notes-phone",
  trigger: {kind: "workflow_dispatch", repository, workflow: run.path, ref: "refs/heads/dev", runId: 123, runAttempt: 2,
    sha: source, workflowSha: source, workflowRef: `${repository}/${run.path}@refs/heads/dev`},
  routine: {id: "notes-phone", harnessRevision: source, authorization: "workflow-dispatch"},
  pullRequest: {number: 42, headSha: appSha, baseSha: source, baseRef: "dev"},
  selection: {platform: "ios-on-mac", app: {backend: "dev"}, build: {headSha: appSha, baseSha: source}}}
const bytes = Buffer.from(`${JSON.stringify(request)}\n`), original = Buffer.from(bytes)
const constraint = harnessVerificationConstraint(bytes, privateSha)
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
const zip = text => execFileSync("python3", ["-c", "import io,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); z.writestr('constraint.json',sys.stdin.buffer.read()); z.close(); sys.stdout.buffer.write(b.getvalue())"], {input: text})
function fixture() {
  const archive = zip(JSON.stringify(constraint))
  const artifact = {id: 78, name: harnessVerificationName(123, 2), expired: false, size_in_bytes: archive.length,
    digest: `sha256:${hash(archive)}`, workflow_run: {id: 123, head_sha: source}}
  const requestArtifact = {...artifact, id: 77, name: "mentra-routine-request-123-2"}
  const steps = [{name: HARNESS_VERIFICATION_STEP, status: "completed", conclusion: "success"}]
  const jobs = [{id: 99, run_id: 123, run_attempt: 2, head_sha: source, status: "completed", steps}]
  const state = {jobs, total: 1, artifacts: [requestArtifact, artifact], archive, sends: []}
  const github = {rest: {actions: {
    getWorkflowRunAttempt: async () => ({data: run}),
    listJobsForWorkflowRunAttempt: async input => {
      assert.equal(input.run_id, 123); assert.equal(input.attempt_number, 2)
      return {data: {total_count: state.total, jobs: state.jobs}}
    },
    listWorkflowRunArtifacts: () => {}, downloadArtifact: async input => {assert.equal(input.artifact_id, 78); return {data: state.archive}},
    createWorkflowDispatch: async input => {state.sends.push(input)},
  }, pulls: {get: async () => ({data: {number: 42, state: "open", base: {ref: "dev"},
    head: {sha: appSha, repo: {full_name: repository}}}})},
    git: {getRef: async () => ({data: {ref: "refs/heads/dev", object: {type: "commit", sha: source}}})}}, paginate: async () => state.artifacts}
  return {state, github, artifact}
}

test("companion binds exact bytes and all selectors without changing the legacy request", () => {
  assert.deepEqual(bytes, original)
  assert.equal(validateHarnessVerification(constraint, bytes, run, "notes-phone"), privateSha)
  for (const delta of [{repository: "other/repo"}, {runId: 124}, {runAttempt: 1}, {routineId: "captions-phone"}, {sha256: "d".repeat(64)}])
    assert.throws(() => validateHarnessVerification({...constraint, request: {...constraint.request, ...delta}}, bytes, run, "notes-phone"))
  for (const value of [{...constraint, extra: true}, {...constraint, expectedHarnessSha: "main"},
    {...constraint, request: {...constraint.request, extra: true}}, {...constraint, kind: "other"}])
    assert.throws(() => validateHarnessVerification(value, bytes, run, "notes-phone"))
  assert.throws(() => validateHarnessVerification(constraint, Buffer.from(JSON.stringify(request)), run, "notes-phone"))
})

test("completed publication requires the bound companion; deleting it cannot downgrade", async () => {
  const f = fixture()
  assert.equal((await harnessVerificationArtifact(f.github, repo, run, f.state.artifacts)).id, 78)
  f.state.artifacts.pop()
  await assert.rejects(() => harnessVerificationArtifact(f.github, repo, run, f.state.artifacts), /required.*missing/i)
  assert.equal(f.state.sends.length, 0)
})

test("legacy and explicitly skipped publication allow only ordinary requests", async () => {
  for (const steps of [[], [{name: HARNESS_VERIFICATION_STEP, status: "completed", conclusion: "skipped"}]]) {
    const f = fixture(); f.state.jobs[0].steps = steps
    await assert.rejects(() => harnessVerificationArtifact(f.github, repo, run, f.state.artifacts), /Unexpected/)
    f.state.artifacts.pop()
    assert.equal(await harnessVerificationArtifact(f.github, repo, run, f.state.artifacts), null)
  }
})

test("unknown, partial or ambiguous step and artifact metadata never authorize dispatch", async () => {
  for (const change of [
    f => {f.state.jobs[0].steps.push({...f.state.jobs[0].steps[0]})},
    f => {f.state.jobs[0].steps[0].conclusion = "failure"},
    f => {f.state.jobs[0].steps[0].status = "in_progress"},
    f => {delete f.state.jobs[0].steps}, f => {f.state.jobs[0].run_attempt = 1},
    f => {f.state.jobs[0].run_id = 124}, f => {f.state.jobs[0].head_sha = privateSha}, f => {f.state.total = 2}, f => {f.state.jobs = []},
    f => {f.state.artifacts.push({...f.artifact, id: 79})}, f => {f.artifact.expired = true},
    f => {f.artifact.workflow_run.head_sha = privateSha}, f => {f.artifact.digest = null},
  ]) {
    const f = fixture(); change(f)
    await assert.rejects(() => planDeviceDispatch({github: f.github, context}))
    assert.equal(f.state.sends.length, 0)
  }
})

test("public callback authenticates the ZIP and forwards only the exact private pin", async () => {
  const f = fixture(), plan = await planDeviceDispatch({github: f.github, context})
  assert.equal(plan.harnessVerification, true)
  await dispatchReadyRequest({github: f.github, privateGithub: f.github, context, plan, bytes})
  assert.deepEqual(f.state.sends, [{owner: repo.owner, repo: "Mentra-Automated-Testing", workflow_id: "device-routine.yml", ref: "main",
    inputs: {source_repository: repository, request_run_id: "123", request_attempt: "2", routine_id: "notes-phone", expected_harness_sha: privateSha}}])
  assert.deepEqual(bytes, original)
  f.state.sends = []; f.state.archive = Buffer.from("changed after listing")
  await assert.rejects(() => dispatchReadyRequest({github: f.github, privateGithub: f.github, context, plan, bytes}), /digest/)
  assert.equal(f.state.sends.length, 0)
})

test("same-attempt companion rejects other request bytes and excessive decoded content", async () => {
  const f = fixture()
  await assert.rejects(() => readHarnessVerification(f.github, repo, run, Buffer.from(JSON.stringify(request)), "notes-phone"), /exact request/)
  f.state.archive = zip(" ".repeat(8192) + JSON.stringify(constraint))
  f.artifact.digest = `sha256:${hash(f.state.archive)}`
  await assert.rejects(() => readHarnessVerification(f.github, repo, run, bytes, "notes-phone"))
})


test("issuer writes only a separate companion and preserves the exact legacy request bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-constraint-"))
  try {
    await mkdir(join(directory, "routine-request"))
    await writeFile(join(directory, "routine-request/request.json"), bytes)
    const module = new URL("./harness-verification.mjs", import.meta.url).href
    execFileSync(process.execPath, ["--input-type=module", "-e",
      `import {writeHarnessVerification} from ${JSON.stringify(module)}; await writeHarnessVerification(${JSON.stringify(privateSha)});`], {cwd: directory})
    assert.deepEqual(await readFile(join(directory, "routine-request/request.json")), original)
    const output = await readFile(join(directory, "harness-verification/constraint.json"))
    assert.ok(output.length <= 8192)
    assert.equal(validateHarnessVerification(JSON.parse(output), bytes, run, "notes-phone"), privateSha)
    const workflow = await readFile(new URL("../workflows/request-e2e-routine.yml", import.meta.url), "utf8")
    assert.match(workflow, /name: Publish immutable request generation[\s\S]*?path: routine-request\/request\.json/)
    assert.match(workflow, /name: Publish harness verification constraint[\s\S]*?path: harness-verification\/constraint\.json/)
  } finally { await rm(directory, {recursive: true, force: true}) }
})
