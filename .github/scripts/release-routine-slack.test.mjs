import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import {readFileSync} from "node:fs"
import test from "node:test"
import {applyRoutineResult, ROUTINE_BLOCK} from "./release-slack-message.mjs"
import {jobName, prepareRoutineUpdate, readActionsJson, resolveRoutineNotifications, stateName, terminalRow, WORKFLOW} from "./release-routine-slack.mjs"

const repo = {owner: "Mentra-Community", repo: "MentraOS"}, privateRepo = {owner: "Mentra-Community", repo: "Mentra-Automated-Testing"}
const request = JSON.parse(readFileSync(new URL("fixtures/coordinated-routine-request.json", import.meta.url))).request
const run = (id, overrides = {}) => ({id, run_attempt: 1, head_sha: "b".repeat(40), head_branch: "dev", event: "workflow_dispatch",
  status: "completed", conclusion: "success", path: WORKFLOW, repository: {full_name: "Mentra-Community/MentraOS"},
  head_repository: {full_name: "Mentra-Community/MentraOS"}, created_at: "2026-09-23T01:00:00Z", ...overrides})
const worker = run(600, {head_branch: "main", head_sha: "c".repeat(40), path: ".github/workflows/device-routine.yml",
  repository: {full_name: "Mentra-Community/Mentra-Automated-Testing"}, head_repository: {full_name: "Mentra-Community/Mentra-Automated-Testing"}})
const terminal = () => ({schemaVersion: 1, kind: "mentra-routine-terminal",
  privateRun: {repository: worker.repository.full_name, runId: 600, runAttempt: 1, revision: worker.head_sha},
  request: {repository: "Mentra-Community/MentraOS", runId: 500, runAttempt: 1, routineId: "no-glasses"},
  status: "passed", resultRunId: request.requestId,
  checks: {test: true, teardown: true, returnVerification: true, evidence: true, fixture: true, publication: true, settlement: true}})
const notification = () => ({schemaVersion: 1, kind: "mentra-release-slack-message",
  build: {repository: "Mentra-Community/MentraOS", channel: "dev", runId: 100, headSha: "a".repeat(40), release: "3.3.0-dev.223", archiveSha256: "e".repeat(64)},
  producer: {runId: 100, runAttempt: 2, headSha: "a".repeat(40)}, message: {channel: "CDEV", ts: "100.123", botId: "BBUILDS"},
  payload: {blocks: [{type: "section", text: {type: "mrkdwn", text: "Original downloads / OTA"}},
    {type: "section", block_id: ROUTINE_BLOCK, text: {type: "mrkdwn", text: "Pending"}}]}, rows: {}})
const plan = () => ({notification: notification(), row: terminalRow(terminal(), worker, request), sourceCreatedAt: "2026-09-23T00:00:00Z"})
const context = {repo, eventName: "workflow_dispatch", ref: "refs/heads/dev", runId: 701}

function resolver(overrides = {}) {
  const values = {terminal: terminal(), request: structuredClone(request), notification: notification(), worker: structuredClone(worker), ...overrides}
  const github = {rest: {actions: {
    listWorkflowRunArtifacts: "artifacts",
    getWorkflowRunAttempt: async ({run_id}) => ({data: run_id === 500
      ? run(500, {path: ".github/workflows/request-e2e-routine.yml"})
      : run(100, {run_attempt: 2, head_sha: "a".repeat(40)})}),
  }}, paginate: async () => [{name: "release-slack-message-100-2"}]}
  const privateGithub = {rest: {actions: {getWorkflowRunAttempt: async () => ({data: values.worker})}}}
  return {github, privateGithub, context, workerRunId: 600, workerAttempt: 1,
    verify: async () => {}, read: async (_github, _repo, _run, name) => name.startsWith("routine-terminal-")
      ? {[`routine-terminal-${values.terminal.request.routineId}.json`]: values.terminal} : name.startsWith("mentra-routine-request-")
      ? {"request.json": values.request} : {"slack-release-message.json": values.notification}}
}

test("resolves a terminal result only to its exact bot-owned release post", async () => {
  const result = await resolveRoutineNotifications(resolver())
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].row, plan().row)
})
test("wrong private revision, request attempt and build archive cannot update", async () => {
  for (const corrupt of [
    values => { values.terminal.privateRun.revision = "d".repeat(40) },
    values => { values.terminal.request.runAttempt = 2 },
    values => { values.notification.build.archiveSha256 = "f".repeat(64) },
    values => { values.notification.build.headSha = "f".repeat(40) },
    values => { values.worker.head_branch = "untrusted" },
  ]) {
    const values = {terminal: terminal(), notification: notification(), worker: structuredClone(worker)}
    corrupt(values)
    await assert.rejects(resolveRoutineNotifications(resolver(values)))
  }
})
test("passing requires every dimension and an actually published matching result", () => {
  for (const key of Object.keys(terminal().checks)) {
    const invalid = terminal(); invalid.checks[key] = false
    assert.throws(() => terminalRow(invalid, worker, request), /contradicts/)
  }
  assert.throws(() => terminalRow({...terminal(), resultRunId: "another-run"}, worker, request), /contradicts/)
  assert.throws(() => terminalRow({...terminal(), resultRunId: undefined}, worker, request), /contradicts/)
})
test("skipped nightly Call retains its published intake result without weakening normal result identity", async () => {
  const call = structuredClone(request)
  call.routine.id = "mentra-call"
  call.requestId = "routine-500-1-dev-mentra-call"
  call.sequence = {kind: "nightly-ota-call", runId: 800, runAttempt: 1, member: "mentra-call"}
  const skipped = terminal()
  skipped.request.routineId = "mentra-call"
  skipped.status = "blocked"
  skipped.testOutcome = "not-run"
  skipped.resultRunId = `${call.requestId}-intake`
  for (const key of ["test", "teardown", "returnVerification", "evidence", "fixture"]) skipped.checks[key] = false
  const [resolved] = await resolveRoutineNotifications(resolver({request: call, terminal: skipped}))
  assert.equal(resolved.row.resultRunId, skipped.resultRunId)
  assert.equal(resolved.row.status, "blocked")
  const message = applyRoutineResult(resolved.notification, resolved.row)
  assert.match(JSON.stringify(message.payload), /testRun=routine-500-1-dev-mentra-call-intake/)
  for (const corrupt of [
    (t, r) => { r.sequence = undefined }, (t, r) => { r.sequence.member = "day1-ota" },
    (t, r) => { r.schemaVersion = 1 }, t => { t.testOutcome = "unknown" }, t => { t.status = "failed" },
    t => { t.checks.publication = false }, t => { t.resultRunId = "routine-499-1-dev-mentra-call-intake" },
    t => { t.status = "passed"; t.testOutcome = "passed"; for (const key of Object.keys(t.checks)) t.checks[key] = true },
  ]) {
    const changed = structuredClone(skipped), source = structuredClone(call); corrupt(changed, source)
    assert.throws(() => terminalRow(changed, worker, source), /contradicts/)
  }
})
test("webhook-era posts with no editable receipt are left alone", async () => {
  const options = resolver(); options.github.paginate = async () => []
  assert.deepEqual(await resolveRoutineNotifications(options), [])
})
test("a notification-only retry does not need to share the original publication attempt", async () => {
  const later = notification(); later.producer.runAttempt = 3
  const options = resolver({notification: later})
  options.github.paginate = async () => [{name: "release-slack-message-100-3"}]
  const [result] = await resolveRoutineNotifications(options)
  assert.equal(request.source.publicationAttempt, 2)
  assert.equal(result.notification.producer.runAttempt, 3)
})
test("multiple notification attempts continue editing the original matching post", async () => {
  const options = resolver(), original = options.read
  options.github.paginate = async () => [{id: 1, name: "release-slack-message-100-3"}, {id: 2, name: "release-slack-message-100-2"}]
  options.read = async (...args) => {
    const response = await original(...args)
    if (args[3] === "release-slack-message-100-3") {
      const later = notification(); later.producer.runAttempt = 3; later.message.ts = "300.123"
      return {"slack-release-message.json": later}
    }
    return response
  }
  const [result] = await resolveRoutineNotifications(options)
  assert.equal(result.notification.message.ts, "100.123")
})
test("artifact digest is checked before JSON is read", async () => {
  const bytes = Buffer.from("synthetic archive"), digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
  const github = {rest: {actions: {listWorkflowRunArtifacts: "artifacts", downloadArtifact: async () => ({data: bytes})}},
    paginate: async () => [{name: "receipt", id: 1, size_in_bytes: bytes.length, digest, workflow_run: {id: 600, head_sha: worker.head_sha}}]}
  const options = {readZip: async () => ({"receipt.json": {valid: true}})}
  assert.deepEqual(await readActionsJson(github, privateRepo, worker, "receipt", ["receipt.json"], options), {"receipt.json": {valid: true}})
  github.rest.actions.downloadArtifact = async () => ({data: Buffer.from("changed")})
  await assert.rejects(readActionsJson(github, privateRepo, worker, "receipt", ["receipt.json"], options), /digest differs/)
})

function historyFixture({previousState, previousStep = "success", retained = true, previousAttempt = 1} = {}) {
  const currentPlan = plan()
  const previous = run(700), current = run(701, {status: "in_progress"})
  const oldJob = {id: 70, name: jobName(currentPlan).replace("no-glasses", "day1-ota"), run_attempt: previousAttempt,
    status: "completed", started_at: "2026-09-23T02:00:00Z", completed_at: "2026-09-23T02:01:00Z",
    steps: [{name: "Update original Slack message", started_at: "2026-09-23T02:00:30Z", conclusion: previousStep}]}
  const currentJob = {id: 71, name: jobName(currentPlan), run_attempt: 1, status: "in_progress", started_at: "2026-09-23T02:02:00Z"}
  const github = {rest: {actions: {listWorkflowRuns: async () => ({data: {total_count: 2, workflow_runs: [current, previous]}}),
    listJobsForWorkflowRun: "jobs", listWorkflowRunArtifacts: "artifacts"}},
  paginate: async (method, {run_id}) => method === "jobs" ? run_id === 701 ? [currentJob] : [oldJob]
    : retained ? [{id: 1, name: stateName(700, 1, "day1-ota")}] : []}
  let saved
  return {options: {github, context, plan: currentPlan, runAttempt: 1,
    read: async () => ({"slack-update-state.json": previousState ?? applyRoutineResult(notification(), {...currentPlan.row,
      routineId: "day1-ota", requestRunId: 499, status: "failed", resultRunId: "routine-499-1-dev-day1-ota"})}),
    write: async (_path, contents) => { saved = JSON.parse(contents) }}, saved: () => saved, oldJob, currentJob}
}
test("a previous failed Slack call still contributes its retained desired state", async () => {
  const fixture = historyFixture({previousStep: "failure"})
  const result = await prepareRoutineUpdate(fixture.options)
  assert.equal(result.rows["no-glasses"].status, "passed")
  assert.equal(result.rows["day1-ota"].status, "failed")
  assert.deepEqual(fixture.saved(), result)
})
test("retained successful job clones reuse their original state artifact attempt", async () => {
  const fixture = historyFixture(), original = fixture.options.github.paginate
  fixture.options.github.paginate = async (method, coordinates) => {
    const values = await original(method, coordinates)
    return method === "jobs" && coordinates.run_id === 700 ? [...values, {...values[0], id: 72, run_attempt: 2}] : values
  }
  const result = await prepareRoutineUpdate(fixture.options)
  assert.equal(result.rows["day1-ota"].status, "failed")
})
test("missing state after an applied update is visible failure, never erased rows", async () => {
  const fixture = historyFixture({retained: false})
  await assert.rejects(prepareRoutineUpdate(fixture.options), /no longer retained/)
  assert.equal(fixture.saved(), undefined)
})
test("a state belonging to another post cannot replace this one", async () => {
  const altered = notification(); altered.message.ts = "900.123"
  await assert.rejects(prepareRoutineUpdate(historyFixture({previousState: altered}).options), /different release post/)
})
test("same-second ambiguous update order does not silently discard a routine", async () => {
  const fixture = historyFixture(); fixture.oldJob.started_at = fixture.currentJob.started_at
  await assert.rejects(prepareRoutineUpdate(fixture.options), /Ambiguous/)
})
test("every Slack credential consumer selects the notification environment on a hosted job", () => {
  const expected = ["coordinated-release.yml/notify-slack", "notify-release-routine.yml/resolve", "notify-release-routine.yml/update"]
  const consumers = [], environmentJobs = []
  for (const name of ["coordinated-release.yml", "notify-release-routine.yml"]) {
    const source = readFileSync(new URL(`../workflows/${name}`, import.meta.url), "utf8")
    const jobs = source.split("\njobs:\n")[1].split(/(?=^  [a-z0-9-]+:\n)/m)
    for (const job of jobs) {
      const id = `${name}/${job.match(/^  ([a-z0-9-]+):/)?.[1]}`
      if (/^    environment: build-notifications$/m.test(job)) environmentJobs.push(id)
      if (!job.includes("secrets.SLACK_BUILDS_BOT_TOKEN")) continue
      consumers.push(id)
      assert.match(job, /^    environment: build-notifications$/m, `${id} cannot read the environment secret`)
      assert.match(job, /^    runs-on: ubuntu-latest$/m)
      assert.doesNotMatch(job, /^    uses:/m)
    }
  }
  assert.deepEqual(consumers, expected)
  assert.deepEqual(environmentJobs, expected)
})

test("workflow keeps pending routine updates and persists state before chat.update", () => {
  const workflow = readFileSync(new URL("../workflows/notify-release-routine.yml", import.meta.url), "utf8")
  assert.match(workflow, /queue: max/)
  assert.match(workflow, /cancel-in-progress: false/)
  assert.ok(workflow.indexOf("Retain desired message before updating Slack") < workflow.indexOf("name: Update original Slack message"))
  assert.doesNotMatch(workflow, /chat\.postMessage/)
})
test("PR and dev workflow-only or notification-script edits run the routine checks", () => {
  const workflow = readFileSync(new URL("../workflows/e2e-setup-checks.yml", import.meta.url), "utf8")
  for (const event of ["pull_request", "push"]) {
    const section = workflow.match(new RegExp(`^  ${event}:\\n((?:    .*\\n|\\n)+)`, "m"))?.[1]
    assert.ok(section, `${event} trigger is configured`)
    for (const path of [".github/workflows/notify-release-routine.yml", ".github/scripts/release-slack-message*", ".github/scripts/release-routine-slack*"]) {
      assert.ok(section.includes(`- "${path}"`), `${event} includes ${path}`)
    }
  }
})


test("Android results authenticate the sibling Mac archive attached to the original release post", async () => {
  const androidRequest = structuredClone(request)
  androidRequest.routine.id = "no-glasses-android"
  androidRequest.requestId += "-android"
  androidRequest.selection.platform = "android"
  androidRequest.selection.archive.sha256 = "9".repeat(64)
  const result = terminal()
  result.request.routineId = "no-glasses-android"
  result.resultRunId = androidRequest.requestId
  let lookups = 0
  const f = {...resolver({request: androidRequest, terminal: result}), published: async input => {
    lookups++
    assert.deepEqual(input, {identity: request.selection.build.releaseIdentity, channel: "dev",
      sourceCommit: request.selection.build.sourceCommit})
    return {archive: {sha256: "e".repeat(64)}}
  }}
  const plans = await resolveRoutineNotifications(f)
  assert.equal(lookups, 1)
  assert.equal(plans[0].row.routineId, "no-glasses-android")
  const applied = applyRoutineResult(plans[0].notification, plans[0].row)
  assert.match(JSON.stringify(applied.payload), /Android no-glasses UI/)
  await assert.rejects(resolveRoutineNotifications({...f, published: async () => ({archive: {sha256: "f".repeat(64)}})}), /another tested build/)
})
