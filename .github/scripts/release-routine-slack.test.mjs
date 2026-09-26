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

// Cancelled before any runner: projected from GitHub metadata, never as a test result.
// GitHub run/job/callback receipts are actual (see the fixture's provenance). The
// request.json body and Slack post receipt were not captured; they adapt the
// repository's coordinated request fixture to the actual run/build identities.
const dev404 = JSON.parse(readFileSync(new URL("fixtures/cancelled-unexecuted-routine.json", import.meta.url)))
const dev404Request = (channel = "dev") => {
  const value = structuredClone(request), {publicRequestRun: source, sourceBuild} = dev404
  Object.assign(value.trigger, {runId: source.id, runAttempt: source.run_attempt, sha: source.head_sha, workflowSha: source.head_sha})
  value.routine.harnessRevision = source.head_sha
  value.requestId = `routine-${source.id}-${source.run_attempt}-${channel}-no-glasses`
  value.source = {...value.source, channel, buildRunId: sourceBuild.runId, publicationAttempt: 1}
  value.selection.build = {...value.selection.build, sourceCommit: sourceBuild.headSha, releaseIdentity: sourceBuild.release}
  value.selection.app.backend = channel
  return value
}
const dev404Post = (channel = "dev") => ({schemaVersion: 1, kind: "mentra-release-slack-message",
  build: {repository: "Mentra-Community/MentraOS", channel, runId: dev404.sourceBuild.runId, headSha: dev404.sourceBuild.headSha,
    release: dev404.sourceBuild.release, archiveSha256: request.selection.archive.sha256},
  producer: {runId: dev404.sourceBuild.runId, runAttempt: 1, headSha: dev404.sourceBuild.headSha},
  message: {channel: "CBUILDS", ts: "1790397224.657789", botId: "BBUILDS"},
  payload: {blocks: [{type: "section", text: {type: "mrkdwn", text: "Downloads / OTA / build passed"}}, {type: "section", block_id: ROUTINE_BLOCK,
    text: {type: "mrkdwn", text: "No-glasses UI — Automatic request follows successful workflow completion; execution and results are pending."}}]}, rows: {}})

/** Minimal GitHub REST double: the resolver reads the same endpoint shapes GitHub returns. */
function actionsApi(repository, runs, jobs, artifacts = {}) {
  const inRange = (item, created) => {
    if (!created) return true
    const [from, to] = created.split("..").map(Date.parse)
    return Date.parse(item.created_at) >= from && Date.parse(item.created_at) <= to
  }
  // GitHub keeps every attempt; run lists and GET run return only the latest one.
  const latest = () => runs.filter(item => !runs.some(other => other.id === item.id && other.run_attempt > item.run_attempt))
  const actions = {
    getWorkflowRun: async ({run_id}) => {
      const found = latest().find(item => item.id === run_id)
      if (!found) throw Object.assign(new Error("Not Found"), {status: 404})
      return {data: structuredClone(found)}
    },
    getWorkflowRunAttempt: async ({run_id, attempt_number}) => {
      const found = runs.find(item => item.id === run_id && item.run_attempt === attempt_number)
      if (!found) throw Object.assign(new Error("Not Found"), {status: 404})
      return {data: structuredClone(found)}
    },
    listWorkflowRuns: async ({workflow_id, event, branch, created, page}) => {
      const all = latest().filter(item => item.path === workflow_id && item.event === event && item.head_branch === branch && inRange(item, created))
      return {data: {total_count: all.length, workflow_runs: structuredClone(all.slice((page - 1) * 100, page * 100))}}
    },
    listJobsForWorkflowRun: async ({run_id}) => ({data: {jobs: structuredClone(jobs.filter(item => item.run_id === run_id))}}),
    listJobsForWorkflowRunAttempt: async ({run_id, attempt_number}) =>
      ({data: {jobs: structuredClone(jobs.filter(item => item.run_id === run_id && item.run_attempt === attempt_number))}}),
    listWorkflowRunArtifacts: async ({run_id}) => ({data: {artifacts: structuredClone(artifacts[run_id] ?? [])}}),
  }
  return {repository, rest: {actions}, paginate: async (method, params) => {
    const {data} = await method(params)
    return data.artifacts ?? data.jobs ?? data.workflow_runs
  }}
}

const callback = v => v.dispatcher.window.workflow_runs.find(item => item.id === 36218261570)
const dispatchJob = v => v.dispatcher.jobs.find(item => item.name === "Dispatch trusted request")
const send = v => dispatchJob(v).steps.find(step => step.name === "Queue the ready request in the private repository")

function cancelled({channel = "dev", corrupt = () => {}, workerAttempt = 1} = {}) {
  const values = {requestRun: structuredClone(dev404.publicRequestRun), worker: structuredClone(dev404.privateRun),
    workerJobs: structuredClone(dev404.privateJobs), dispatcher: structuredClone(dev404.dispatcher),
    request: dev404Request(channel), post: dev404Post(channel), privateRuns: [], privateArtifacts: [], publicRuns: []}
  corrupt(values)
  const build = run(dev404.sourceBuild.runId, {path: ".github/workflows/coordinated-release.yml", head_sha: dev404.sourceBuild.headSha,
    head_branch: channel, event: "push", created_at: "2026-09-26T03:10:00Z"})
  const github = actionsApi("MentraOS", [values.requestRun, ...values.dispatcher.window.workflow_runs, build, ...values.publicRuns], values.dispatcher.jobs,
    {[build.id]: [{name: `release-slack-message-${build.id}-1`}]})
  const privateGithub = actionsApi("Mentra-Automated-Testing", [values.worker, ...values.privateRuns], values.workerJobs,
    {[values.worker.id]: values.privateArtifacts})
  const verified = []
  return {github, privateGithub, context, workerRunId: dev404.privateRun.id, workerAttempt,
    verify: async ({request: verifiedRequest}) => { verified.push(verifiedRequest.requestId) }, verified,
    read: async (_github, _repo, source, name) => name === `mentra-routine-request-${source.id}-${source.run_attempt}`
      ? {"request.json": structuredClone(values.request)} : name === `release-slack-message-${dev404.sourceBuild.runId}-1`
      ? {"slack-release-message.json": structuredClone(values.post)} : readActionsJson(_github, _repo, source, name, ["routine-terminal-no-glasses.json"])}
}

test("actual dev404 request cancelled before any runner updates its existing post without a result", async () => {
  // The actual callback window also holds the concurrent callback for request 36218240618.
  assert.equal(dev404.dispatcher.window.workflow_runs.length, 2)
  const options = cancelled()
  const [plan] = await resolveRoutineNotifications(options)
  assert.deepEqual(options.verified, ["routine-36218243731-1-dev-no-glasses"])
  assert.deepEqual(plan.row, {routineId: "no-glasses", requestRunId: 36218243731, requestAttempt: 1,
    privateRunId: 36218299907, privateAttempt: 1, status: "cancelled"})
  assert.equal(plan.notification.message.ts, "1790397224.657789")
  assert.equal(plan.notification.build.release, "3.3.0-dev.404")
  const updated = applyRoutineResult(plan.notification, plan.row)
  const text = updated.payload.blocks[1].text.text
  assert.match(text, /No-glasses UI — \*Cancelled before execution; no test result\* · <https:\/\/github\.com\/Mentra-Community\/MentraOS\/actions\/runs\/36218243731\/attempts\/1\|Request>/)
  assert.doesNotMatch(text, /Passed|Failed|Recording|testRun=|pending/)
  assert.deepEqual(updated.payload.blocks[0], plan.notification.payload.blocks[0])
  assert.equal(updated.rows["no-glasses"].resultRunId, undefined)
  // PR comments render worker receipts only; there is none to invent here.
  const {resolvePrRoutineResults} = await import("./pr-routine-result.mjs")
  assert.deepEqual(await resolvePrRoutineResults(cancelled()), [])
})

test("staging cancellation updates its own post from the original request without dispatching a test", async () => {
  const options = cancelled({channel: "staging"})
  const [plan] = await resolveRoutineNotifications(options)
  assert.equal(plan.notification.build.channel, "staging")
  assert.equal(plan.row.status, "cancelled")
  assert.deepEqual(options.verified, ["routine-36218243731-1-staging-no-glasses"])
  for (const api of [options.github, options.privateGithub]) assert.equal(api.rest.actions.createWorkflowDispatch, undefined)
})

test("cancellation is refused unless GitHub proves the exact request never reached a runner", async () => {
  const workerStep = {name: "Check out the immutable private workflow revision", status: "completed", conclusion: "success", number: 1,
    started_at: "2026-09-26T05:50:00Z", completed_at: "2026-09-26T05:50:02Z"}
  const identity = /Workflow identity differs/, notProven = /only a cancelled attempt that never reached a runner/
  const executed = /may have reached a runner/, binding = /differs from its requested routine/
  const producer = /Request differs from its trusted producer/, dispatcher = /Trusted dispatcher/, post = /another tested build/
  const creator = /not created by the trusted dispatcher App/, person = {login: "PhilippeFerreiraDeSousa", id: 12345678, type: "User"}
  // Frozen invalid examples: each must be refused for its own reason.
  const invalid = {
    "private repository": [v => { v.worker.repository.full_name = "Mentra-Community/MentraOS" }, identity],
    "nightly workflow path": [v => { v.worker.path = ".github/workflows/nightly-device-routines.yml" }, notProven],
    "feature branch": [v => { v.worker.head_branch = "codex/forged" }, identity],
    "push event": [v => { v.worker.event = "push" }, identity],
    "jobs from another attempt": [v => { v.workerJobs[0].run_attempt = 2 }, /jobs are ambiguous/],
    "failed without receipt": [v => { v.worker.conclusion = "failure" }, /Expected one retained notification artifact/],
    "expired terminal receipt": [v => { v.privateArtifacts.push({id: 9, name: "routine-terminal-36218299907-1", expired: true}) }, /expired/],
    "malformed title": [v => { v.worker.display_title = "Device routine request 36218243731" }, notProven],
    "title for another request": [v => { v.worker.display_title = "Device routine request 36218243730 / attempt 1" }, /Not Found/],
    "title for another request attempt": [v => { v.worker.display_title = "Device routine request 36218243731 / attempt 2" }, /Not Found/],
    "worker step started": [v => { v.workerJobs[0].steps.push(workerStep) }, executed],
    "runner assigned": [v => { v.workerJobs[0].runner_id = 42; v.workerJobs[0].runner_name = "mentra-mac-mini" }, executed],
    "runner name only": [v => { v.workerJobs[0].runner_name = "mentra-mac-mini" }, executed],
    "runner group assigned": [v => { v.workerJobs[0].runner_group_id = 1 }, executed],
    "job not cancelled": [v => { v.workerJobs[0].conclusion = "failure" }, executed],
    "job still queued": [v => { v.workerJobs[0].status = "queued"; v.workerJobs[0].conclusion = null }, executed],
    "ambiguous jobs": [v => { v.workerJobs.push({...v.workerJobs[0], id: 108338589125}) }, /jobs are ambiguous/],
    "other routine labels": [v => { v.workerJobs[0].labels[2] = "mentra-routine-day1-ota" }, binding],
    "android labels for Mac request": [v => { v.workerJobs[0].labels[1] = "android" }, binding],
    "job for another revision": [v => { v.workerJobs[0].head_sha = "f".repeat(40) }, binding],
    "request routine differs": [v => { v.request.routine.id = "day1-ota" }, binding],
    "request platform differs": [v => { v.request.selection.platform = "android" }, /not a device worker routine/],
    "request source head differs": [v => { v.request.trigger.sha = "f".repeat(40) }, producer],
    "request not ready": [v => { v.request.status = "no-artifact" }, producer],
    "request run failed": [v => { v.requestRun.conclusion = "failure" }, /did not succeed/],
    "request from feature branch": [v => { v.requestRun.head_branch = "codex/forged" }, identity],
    "worker predates request": [v => { v.worker.created_at = "2026-09-26T04:30:00Z" }, /predates/],
    "worker created by a person": [v => { v.worker.actor = v.worker.triggering_actor = person }, creator],
    "worker rerun by a person": [v => { v.worker.triggering_actor = person }, creator],
    "worker created by another App": [v => { v.worker.actor = v.worker.triggering_actor = {login: "github-actions[bot]", id: 41898282, type: "Bot"} }, creator],
    "dispatcher login on another account": [v => { v.worker.actor = v.worker.triggering_actor = {...v.worker.actor, id: 1} }, creator],
    "dispatcher absent": [v => { callback(v).display_title = "Device request callback 36218243730 / attempt 1" }, dispatcher],
    "dispatcher from another workflow": [v => { callback(v).path = ".github/workflows/request-e2e-routine.yml" }, dispatcher],
    "dispatcher from a feature branch": [v => { callback(v).head_branch = "codex/forged" }, dispatcher],
    "duplicate dispatcher": [v => { v.publicRuns.push({...callback(v), id: 36218261999}) }, dispatcher],
    "dispatcher did not send": [v => { send(v).conclusion = "skipped" }, dispatcher],
    "dispatcher send failed": [v => { send(v).conclusion = "failure" }, dispatcher],
    "dispatcher sent twice": [v => { v.dispatcher.jobs.push({...structuredClone(dispatchJob(v)), id: 108338527999, run_attempt: 2,
      steps: dispatchJob(v).steps.map(step => ({...step, started_at: "2026-09-26T04:40:00Z", completed_at: "2026-09-26T04:40:05Z"}))}) }, dispatcher],
    "worker created outside the send": [v => { send(v).started_at = send(v).completed_at = "2026-09-26T04:35:30Z" }, dispatcher],
    "second private run for the request": [v => { v.privateRuns.push({...v.worker, id: 36218299908, conclusion: "success"}) }, /Private dispatch for this request is ambiguous/],
    "post for another archive": [v => { v.post.build.archiveSha256 = "f".repeat(64) }, post],
    "post for another source": [v => { v.post.build.headSha = "f".repeat(40); v.post.producer.headSha = "f".repeat(40) }, post],
    "post for another release": [v => { v.post.build.release = "3.3.0-dev.403" }, post],
  }
  for (const [name, [corrupt, reason]] of Object.entries(invalid))
    await assert.rejects(resolveRoutineNotifications(cancelled({corrupt})), reason, name)
  await assert.rejects(resolveRoutineNotifications(cancelled({workerAttempt: 2})), /Not Found/)
})

test("a retried dispatcher that cloned its completed send is still one send", async () => {
  const options = cancelled({corrupt: v => { v.dispatcher.jobs.push({...structuredClone(dispatchJob(v)), id: 108338527999, run_attempt: 2}) }})
  assert.equal((await resolveRoutineNotifications(options))[0].row.status, "cancelled")
})

test("cancelled rows only fill pending rows; worker results always outrank them", () => {
  const post = dev404Post(), gen = {requestRunId: 36218243731, requestAttempt: 1, privateRunId: 36218299907, privateAttempt: 1}
  const cancellation = {routineId: "no-glasses", ...gen, status: "cancelled"}
  const android = {routineId: "no-glasses-android", requestRunId: 36218243800, requestAttempt: 1, privateRunId: 36218299950,
    privateAttempt: 1, status: "failed", resultRunId: "routine-36218243800-1-dev-no-glasses-android"}
  const both = applyRoutineResult(applyRoutineResult(post, android), cancellation)
  assert.equal(both.rows["no-glasses"].status, "cancelled")
  assert.deepEqual(both.rows["no-glasses-android"], android)
  assert.match(both.payload.blocks[1].text.text, /Android no-glasses UI — \*Failed\*.*testRun=routine-36218243800-1-dev-no-glasses-android/)
  // Duplicate callbacks are idempotent.
  assert.deepEqual(applyRoutineResult(both, cancellation), both)
  // A newer request's cancellation never hides an earlier completed result.
  const passed = {routineId: "no-glasses", requestRunId: 36218243700, requestAttempt: 1, privateRunId: 36218299900, privateAttempt: 1,
    status: "passed", resultRunId: "routine-36218243700-1-dev-no-glasses"}
  const withPass = applyRoutineResult(post, passed)
  assert.deepEqual(applyRoutineResult(withPass, cancellation), withPass)
  // A later queued attempt of the same request cancelled after a real result cannot hide that result.
  const attempted = {...gen, routineId: "no-glasses", status: "failed", resultRunId: "routine-36218243731-1-dev-no-glasses"}
  const afterResult = applyRoutineResult(post, attempted)
  assert.deepEqual(applyRoutineResult(afterResult, {...cancellation, privateAttempt: 2}), afterResult)
  assert.deepEqual(applyRoutineResult(afterResult, {...cancellation, privateRunId: 36218299999}), afterResult)
  // A worker-attested result for the same request replaces the cancellation, even from an earlier worker run.
  const failed = {...gen, routineId: "no-glasses", privateRunId: 36218299900, status: "failed", resultRunId: "routine-36218243731-1-dev-no-glasses"}
  assert.equal(applyRoutineResult(both, failed).rows["no-glasses"].status, "failed")
  // A newer cancellation may replace an older cancellation only.
  const later = {...cancellation, requestRunId: 36218243800, privateRunId: 36218299960}
  assert.equal(applyRoutineResult(both, later).rows["no-glasses"].requestRunId, 36218243800)
  assert.deepEqual(applyRoutineResult(applyRoutineResult(both, later), cancellation).rows["no-glasses"], later)
  assert.throws(() => applyRoutineResult(post, {...cancellation, resultRunId: "routine-36218243731-1-dev-no-glasses"}), /Invalid routine result row/)
})

test("cancelled worker rows never pass the terminal receipt validator", () => {
  const forged = terminal(); forged.status = "cancelled"
  assert.throws(() => terminalRow(forged, worker, request), /does not match/)
})

test("a cancelled attempt that retained a terminal receipt keeps the ordinary worker-attested result", async () => {
  const stopped = terminal(); stopped.status = "aborted"; stopped.testOutcome = "cancelled"; stopped.resultRunId = undefined
  for (const key of Object.keys(stopped.checks)) stopped.checks[key] = false
  const options = resolver({terminal: stopped, worker: {...structuredClone(worker), conclusion: "cancelled"}})
  options.privateGithub.rest.actions.listWorkflowRunArtifacts = "artifacts"
  options.privateGithub.paginate = async () => [{name: "routine-terminal-600-1"}]
  const [result] = await resolveRoutineNotifications(options)
  assert.equal(result.row.status, "aborted")
  assert.equal(result.row.privateRunId, 600)
})

test("the cancellation proof names the dispatcher job and send step that actually exist", async () => {
  const {DISPATCHER} = await import("./release-routine-slack.mjs")
  const workflow = readFileSync(new URL(`../../${DISPATCHER.workflow}`, import.meta.url), "utf8")
  assert.match(workflow, /^run-name: Device request callback \$\{\{ github\.event\.workflow_run\.id \}\} \/ attempt \$\{\{ github\.event\.workflow_run\.run_attempt \}\}$/m)
  assert.ok(workflow.includes(`|| '${DISPATCHER.job}' }}`))
  assert.equal(workflow.split(`      - name: ${DISPATCHER.step}\n`).length, 2)
  assert.match(workflow.split(`      - name: ${DISPATCHER.step}\n`)[1], /^\s+if: matrix\.mode == 'dispatch'\n[\s\S]*?dispatchReadyRequest/)
})

// Review finding: the dispatcher App can also rerun. A rerun may follow an attempt that executed.
const executedAttempt = v => ({...structuredClone(v.worker), conclusion: "failure", updated_at: "2026-09-26T05:00:00Z"})
const executedJob = v => ({...structuredClone(v.workerJobs[0]), conclusion: "failure", runner_id: 42, runner_name: "mentra-mac-mini",
  runner_group_id: 1, completed_at: "2026-09-26T05:00:00Z",
  steps: [{name: "Enter the enrolled worker once", status: "completed", conclusion: "failure", number: 4,
    started_at: "2026-09-26T04:40:00Z", completed_at: "2026-09-26T05:00:00Z"}]})
const queuedRerun = (v, overrides = {}) => ({...structuredClone(v.worker), run_attempt: 2, run_started_at: "2026-09-26T05:10:00Z", ...overrides})
const queuedRerunJob = v => ({...structuredClone(v.workerJobs[0]), id: 108338589999, run_attempt: 2, started_at: "2026-09-26T05:10:02Z"})
const rerunRefusal = /Only an unrerun first dispatched attempt/

test("a same-App cancelled rerun after an executed attempt without a receipt is refused", async () => {
  // Selected attempt 2 never ran, but attempt 1 executed and failed without retaining a receipt.
  await assert.rejects(resolveRoutineNotifications(cancelled({workerAttempt: 2, corrupt: v => {
    const second = queuedRerun(v), secondJob = queuedRerunJob(v)
    v.worker = executedAttempt(v); v.workerJobs = [executedJob(v), secondJob]; v.privateRuns.push(second)
  }})), rerunRefusal)
  // Even when both attempts were queue cancellations, a rerun is never the dispatcher's own send.
  await assert.rejects(resolveRoutineNotifications(cancelled({workerAttempt: 2, corrupt: v => {
    v.privateRuns.push(queuedRerun(v)); v.workerJobs.push(queuedRerunJob(v))
  }})), rerunRefusal)
})

test("a cancelled first attempt is refused once the run has any later attempt", async () => {
  for (const later of [{status: "queued", conclusion: null}, {status: "in_progress", conclusion: null},
    {status: "completed", conclusion: "failure"}, {status: "completed", conclusion: "cancelled"}]) {
    await assert.rejects(resolveRoutineNotifications(cancelled({corrupt: v => {
      v.privateRuns.push(queuedRerun(v, later)); v.workerJobs.push(queuedRerunJob(v))
    }})), rerunRefusal, JSON.stringify(later))
  }
})

test("latest run metadata must be the same unrerun first attempt", async () => {
  const selected = structuredClone(dev404.privateRun)
  for (const [name, change] of Object.entries({
    "latest revision differs": latest => { latest.head_sha = "f".repeat(40) },
    "latest title differs": latest => { latest.display_title = "Device routine request 36218240618 / attempt 1" },
    "latest conclusion differs": latest => { latest.conclusion = "failure" },
    "latest creator differs": latest => { latest.actor = {login: "PhilippeFerreiraDeSousa", id: 12345678, type: "User"} },
    "latest attempt differs": latest => { latest.run_attempt = 2 },
  })) {
    const options = cancelled(), latest = structuredClone(selected)
    change(latest)
    options.privateGithub.rest.actions.getWorkflowRun = async () => ({data: latest})
    await assert.rejects(resolveRoutineNotifications(options), rerunRefusal, name)
  }
})

test("ordinary terminal receipts from retried attempts keep their exact attempt lineage", async () => {
  const retried = terminal(); retried.privateRun.runAttempt = 2
  const options = resolver({terminal: retried, worker: {...structuredClone(worker), run_attempt: 2}})
  options.workerAttempt = 2
  const [result] = await resolveRoutineNotifications(options)
  assert.equal(result.row.privateAttempt, 2)
  assert.equal(result.row.status, "passed")
})
