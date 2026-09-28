import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import {readFileSync} from "node:fs"
import test from "node:test"
import {publishPrRoutineResult, resolvePrRoutineResults} from "./pr-routine-result.mjs"
import {readActionsJson} from "./release-routine-slack.mjs"

const repository = "Mentra-Community/MentraOS", privateRepository = "Mentra-Community/Mentra-Automated-Testing"
const context = {repo: {owner: "Mentra-Community", repo: "MentraOS"}, eventName: "workflow_dispatch", ref: "refs/heads/dev"}
const requestWorkflow = ".github/workflows/request-e2e-routine.yml"
const bot = {type: "Bot", login: "github-actions[bot]"}
function fixture({outcome = "passed", status = "passed", published = true, workerId = 200, attempt = 1, requestAttempt = 1, android = false, baseRef = "dev",
  routine = android ? "no-glasses-android" : "day1-ota"} = {}) {
  const source = {id: 100, run_attempt: requestAttempt, head_sha: "a".repeat(40), head_branch: "dev", event: "workflow_dispatch",
    status: "completed", conclusion: "success", path: requestWorkflow, repository: {full_name: repository}, head_repository: {full_name: repository}}
  const worker = {...source, id: workerId, run_attempt: attempt, head_sha: "b".repeat(40), head_branch: "main",
    path: ".github/workflows/device-routine.yml", repository: {full_name: privateRepository}, head_repository: {full_name: privateRepository}}
  const request = {schemaVersion: 1, kind: "mentra-routine-request", status: "ready", requestId: `routine-100-${requestAttempt}-4136-${routine}`,
    trigger: {kind: "workflow_dispatch", repository, workflow: requestWorkflow, runId: 100, runAttempt: requestAttempt,
      ref: "refs/heads/dev", sha: source.head_sha, workflowSha: source.head_sha, workflowRef: `${repository}/${requestWorkflow}@refs/heads/dev`},
    pullRequest: {number: 4136, url: `https://github.com/${repository}/pull/4136`, headSha: "c".repeat(40), baseSha: "d".repeat(40),
      headRepository: repository, baseRef}, routine: {id: routine, harnessRevision: source.head_sha},
    selection: {platform: android ? "android" : "ios-on-mac",
      producer: {workflow: `.github/workflows/mentra-app-${android ? "android" : "ios"}-build.yml`, runId: 90, buildAttempt: 1, publicationAttempt: 2},
      build: {headSha: "c".repeat(40), baseSha: "d".repeat(40), buildSha: "e".repeat(40)},
      archive: {name: android ? "mentra-android-pr-4136.apk" : "Mentra-PR-4136.zip", sha256: "1".repeat(64)},
      receipt: {sha256: "2".repeat(64)}, otaManifest: {sha256: "3".repeat(64)}}}
  const terminal = {schemaVersion: 1, kind: "mentra-routine-terminal", status, testOutcome: outcome,
    privateRun: {repository: privateRepository, runId: workerId, runAttempt: attempt, revision: worker.head_sha},
    request: {repository, runId: 100, runAttempt: requestAttempt, routineId: routine},
    ...(published ? {resultRunId: request.requestId} : {}),
    checks: {test: outcome === "passed", teardown: true, returnVerification: true, evidence: true, fixture: true,
      publication: published, settlement: true}}
  return {source, worker, request, terminal, options: {context, workerRunId: workerId, workerAttempt: attempt,
    github: {rest: {actions: {getWorkflowRunAttempt: async () => ({data: source})}}},
    privateGithub: {rest: {actions: {getWorkflowRunAttempt: async () => ({data: worker})}}},
    read: async (_github, _repo, _run, name) => name.startsWith("routine-terminal-")
      ? {[`routine-terminal-${routine}.json`]: terminal} : {"request.json": request}}}
}
async function plan(options) { return (await resolvePrRoutineResults(fixture(options).options))[0] }
function writer() {
  const comments = [], writes = []
  let ambiguousCreate = false
  const github = {paginate: async () => comments, rest: {issues: {
    listComments: "comments",
    createComment: async input => {
      writes.push({kind: "create", ...input})
      const data = {id: comments.length + 1, user: bot, body: input.body}; comments.push(data)
      if (ambiguousCreate) { ambiguousCreate = false; throw new Error("response lost after acceptance") }
      return {data}
    },
    updateComment: async input => {
      writes.push({kind: "update", ...input})
      comments.find(item => item.id === input.comment_id).body = input.body
    },
  }}}
  return {comments, writes, send: value => publishPrRoutineResult({github, context, plan: value}),
    loseResponse: () => { ambiguousCreate = true }}
}

/** The terminal read goes through the production `readActionsJson` over one synthetic, digest-bound private artifact:
 * its allowed filenames are the reporting routine set, so an unlisted routine's terminal is refused there. `entries` is
 * what the (synthetic) archive holds; the ZIP extraction itself is replaced by `readZip`. */
function artifactRead(value, entries) {
  const original = value.options.read
  return async (github, repo, run, name, allowedFiles) => {
    if (!name.startsWith("routine-terminal-")) return original(github, repo, run, name, allowedFiles)
    const bytes = Buffer.from(`synthetic retained archive ${name}`)
    const api = {paginate: async () => [{id: 7, name, expired: false, size_in_bytes: bytes.length,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, workflow_run: {id: run.id, head_sha: run.head_sha}}],
    rest: {actions: {listWorkflowRunArtifacts: "listWorkflowRunArtifacts", downloadArtifact: async () => ({data: bytes})}}}
    return readActionsJson(api, repo, run, name, allowedFiles, {readZip: async () => structuredClone(entries)})
  }
}

test("both registered Phone routines post PR results through the terminal reader and resolver; an unknown routine still refuses", async () => {
  for (const [routine, name] of [["captions-phone", "Captions with simulated glasses"], ["notes-phone", "Notes with simulated glasses"]]) {
    const value = fixture({routine})
    value.options.read = artifactRead(value, {[`routine-terminal-${routine}.json`]: value.terminal})
    const [result, ...rest] = await resolvePrRoutineResults(value.options)
    assert.equal(rest.length, 0)
    assert.equal(result.pr, 4136)
    for (const required of [name, "test passed", "Run result: Passed", `?testRun=routine-100-1-4136-${routine}`, "Platform: `ios-on-mac`",
      "Mentra-PR-4136.zip", "actions/runs/200/attempts/1", "actions/runs/100/attempts/1", "routine-terminal-200-1"])
      assert.ok(result.body.includes(required), `${routine}: ${required}`)
    // Filename, request, attempt, revision and forged-success mismatches still refuse the Phone result.
    for (const [change, message] of [
      [f => ({[`routine-terminal-${routine === "captions-phone" ? "notes-phone" : "captions-phone"}.json`]: f.terminal}), /filename differs/],
      [f => { f.terminal.request.routineId = "day1-ota"; return {[`routine-terminal-${routine}.json`]: f.terminal} }, /filename differs/],
      [f => { f.terminal.request.runAttempt = 2; return {[`routine-terminal-${routine}.json`]: f.terminal} }, /request attempt did not succeed/],
      [f => { f.terminal.privateRun.revision = "f".repeat(40); return {[`routine-terminal-${routine}.json`]: f.terminal} }, /does not match/],
      [f => { f.terminal.checks.evidence = false; return {[`routine-terminal-${routine}.json`]: f.terminal} }, /contradicts/],
      [f => { f.terminal.resultRunId = "routine-100-1-4136-day1-ota"; return {[`routine-terminal-${routine}.json`]: f.terminal} }, /contradicts/],
      [f => ({[`routine-terminal-${routine}.json`]: f.terminal, "routine-terminal-arbitrary.json": f.terminal}), /Unexpected artifact entries/],
    ]) {
      const changed = fixture({routine})
      changed.options.read = artifactRead(changed, change(changed))
      await assert.rejects(resolvePrRoutineResults(changed.options), message)
    }
  }
  // A routine outside the shared catalog is refused by the reader's allowlist and by the terminal row.
  const unknown = fixture({routine: "arbitrary-routine"})
  unknown.options.read = artifactRead(unknown, {"routine-terminal-arbitrary-routine.json": unknown.terminal})
  await assert.rejects(resolvePrRoutineResults(unknown.options), /Unexpected artifact entries/)
  await assert.rejects(resolvePrRoutineResults(fixture({routine: "arbitrary-routine"}).options), /does not match/)
})

test("a completed PR run retains candidate, build, request, worker and published recording identities", async () => {
  const result = await plan()
  assert.equal(result.pr, 4136)
  for (const required of ["test passed", "Run result: Passed", "c".repeat(40), "d".repeat(40), "e".repeat(40),
    "1".repeat(64), "2".repeat(64), "3".repeat(64), "actions/runs/90/attempts/2", "actions/runs/200/attempts/1",
    "actions/runs/100/attempts/1", "?testRun=routine-100-1-4136-day1-ota", "routine-terminal-200-1"]) assert.ok(result.body.includes(required), required)
})

test("failed tests, setup failures, cancellation and incomplete publication remain distinct", async () => {
  for (const [outcome, status, label] of [["failed", "failed", "test failed"], ["not-run", "blocked", "test not run"],
    ["cancelled", "aborted", "test cancelled"], ["passed", "upload-incomplete", "test passed"]]) {
    const result = await plan({outcome, status, published: false})
    assert.ok(result.body.includes(label))
    assert.doesNotMatch(result.body, /\?testRun=/)
    assert.match(result.body, /publication is unavailable/)
    assert.doesNotMatch(result.body, /Run result: Passed/)
  }
})

test("older receipts do not turn an absent test verdict into a failed or unrun test", async () => {
  const value = fixture({outcome: "not-run", status: "blocked"}); delete value.terminal.testOutcome
  assert.match((await resolvePrRoutineResults(value.options))[0].body, /test unknown/)
})

test("Android results use the APK selection without depending on a Mac build", async () => {
  const result = await plan({android: true})
  assert.match(result.body, /Android no-glasses UI/)
  assert.match(result.body, /mentra-android-pr-4136.apk/)
  assert.match(result.body, /Platform: `android`/)
})

test("staging PR results name their base while keeping per-execution identity and the central result host", async () => {
  const dev = await plan(), staging = await plan({baseRef: "staging"})
  // Existing dev comments render byte-identically, so retained history is never rewritten.
  assert.ok(dev.body.includes(`- PR base: \`${"d".repeat(40)}\`.`))
  assert.ok(staging.body.includes(`- PR base: \`staging\` at \`${"d".repeat(40)}\`.`))
  assert.equal(staging.marker, dev.marker)
  assert.equal(staging.body.replace("`staging` at ", ""), dev.body)
  assert.match(staging.body, /https:\/\/admin\.dev\.mentraglass\.com\/\?testRun=routine-100-1-4136-day1-ota/)
  const value = writer()
  assert.equal((await value.send(staging)).status, "created")
  assert.equal((await value.send(staging)).status, "unchanged")
  await value.send(await plan({baseRef: "staging", attempt: 2, outcome: "failed", status: "failed"}))
  assert.equal(value.comments.length, 2)
  assert.equal(value.comments[0].body, staging.body)
  for (const baseRef of ["main", "prod", null])
    await assert.rejects(resolvePrRoutineResults(fixture({baseRef}).options), /differ from the trusted request/)
})

test("historical results do not fetch or require the current PR head or open state", async () => {
  const value = fixture()
  // No pulls.get or git.getRef exists: the authenticated request is the historical authority.
  assert.match((await resolvePrRoutineResults(value.options))[0].body, /c{40}/)
})

test("wrong producer, attempt, request, candidate, platform and contradictory verdicts cannot post", async () => {
  for (const corrupt of [
    f => { f.worker.head_branch = "untrusted" }, f => { f.worker.run_attempt = 2 },
    f => { f.source.event = "pull_request" }, f => { f.source.conclusion = "failure" },
    f => { f.terminal.privateRun.revision = "f".repeat(40) }, f => { f.terminal.request.runAttempt = 2 },
    f => { f.request.pullRequest.number = 123 }, f => { f.request.selection.build.headSha = "f".repeat(40) },
    f => { f.request.selection.platform = "android" }, f => { f.request.selection.archive.sha256 = "bad" },
    f => { f.terminal.testOutcome = "not-run" }, f => { f.terminal.resultRunId = "another-result" },
  ]) {
    const value = fixture(); corrupt(value)
    await assert.rejects(resolvePrRoutineResults(value.options))
  }
})

test("publication retries reuse the comment, while worker and request reruns preserve prior history", async () => {
  const value = writer(), first = await plan()
  assert.equal((await value.send(first)).status, "created")
  assert.equal((await value.send(first)).status, "unchanged")
  await value.send(await plan({attempt: 2, outcome: "failed", status: "failed"}))
  await value.send(await plan({requestAttempt: 2, workerId: 201}))
  assert.equal(value.comments.length, 3)
  assert.equal(value.comments[0].body, first.body)
  assert.deepEqual(value.writes.map(entry => entry.kind), ["create", "create", "create"])
})

test("a lost create response is reconciled on retry without posting again", async () => {
  const value = writer(), result = await plan(); value.loseResponse()
  await assert.rejects(value.send(result), /response lost/)
  assert.equal(value.comments.length, 1)
  assert.equal((await value.send(result)).status, "unchanged")
  assert.equal(value.writes.length, 1)
})

test("only the matching GitHub Actions comment is updated; other authors and attempts are preserved", async () => {
  const value = writer(), result = await plan()
  value.comments.push({id: 10, user: {type: "User", login: "contributor"}, body: result.body})
  await value.send(result)
  value.comments[1].body += "\nold rendering"
  assert.equal((await value.send(result)).status, "updated")
  assert.equal(value.comments[0].body, result.body)
  assert.equal(value.writes.at(-1).comment_id, 2)
  value.comments.push({...value.comments[1], id: 20})
  await assert.rejects(value.send(result), /Duplicate/)
})

test("PR comments run independently of Slack configuration with serialized execution keys and no POST retry", () => {
  const workflow = readFileSync(new URL("../workflows/notify-release-routine.yml", import.meta.url), "utf8")
  const comment = workflow.split("\n  comment:\n")[1].split("\n  update:\n")[0]
  assert.match(comment, /pull-requests: write/)
  assert.match(comment, /pr-routine-result-\$\{\{ matrix.privateRunId \}\}-\$\{\{ matrix.privateAttempt \}\}-\$\{\{ matrix.routineId \}\}/)
  assert.match(comment, /cancel-in-progress: false\n      queue: max/)
  assert.match(comment, /retries: 0/)
  assert.doesNotMatch(comment, /SLACK|secrets\./)
  assert.match(workflow, /const prPlans = await resolvePrRoutineResults/)
  const checks = readFileSync(new URL("../workflows/e2e-setup-checks.yml", import.meta.url), "utf8")
  assert.equal(checks.match(/- "\.github\/scripts\/pr-routine-result\*"/g).length, 2)
  assert.match(checks, /pr-routine-result.test.mjs/)
})

test("each final nightly routine's PR result renders on the originating PR only with its own platform and terminal", async () => {
  const names = {"day1-ota": "Day-one OTA", "mentra-call": "Mentra Call", "account-miniapps": "Account and miniapps",
    "connected-glasses": "Connected glasses (Android)", livestreamer: "Livestreamer"}
  for (const [routine, name] of Object.entries(names)) {
    const android = routine === "connected-glasses"
    const [result] = await resolvePrRoutineResults(fixture({routine, android}).options)
    assert.equal(result.pr, 4136)
    assert.equal(result.routineId, routine)
    assert.ok(result.body.startsWith(`<!-- mentra-routine-result:200:1:${routine} -->\n### ${name} — test passed`))
    const crossed = fixture({routine, android: !android})
    await assert.rejects(resolvePrRoutineResults(crossed.options), /differ/)
    const renamed = fixture({routine, android})
    renamed.options.read = async (_github, _repo, _run, file) => file.startsWith("routine-terminal-")
      ? {"routine-terminal-no-glasses.json": renamed.terminal} : {"request.json": renamed.request}
    await assert.rejects(resolvePrRoutineResults(renamed.options))
  }
})
