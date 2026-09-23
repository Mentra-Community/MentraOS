import {createHash} from "node:crypto"
import {mkdir, writeFile} from "node:fs/promises"
import {join} from "node:path"
import {matchingBuildRun, readOtaTargets} from "./notify-pr-builds.mjs"
import {iosReceiptName, validateIosReceipt} from "./pr-ios-artifacts.mjs"
import {artifactUrl} from "./release-artifact-storage.mjs"
import {deviceRoutine, hasRoutineLabel} from "./device-routines.mjs"

export const REQUEST_WORKFLOW = ".github/workflows/request-e2e-routine.yml"
export const REQUEST_LABEL = "routine:day1-ota"
const PRODUCER = "mentra-app-ios-build.yml"
const SHA = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const positive = (value) => Number.isSafeInteger(value) && value > 0
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")

export function sourcePublication(runId, publicationAttempt) {
  const absent = (value) => value === undefined || value === ""
  if (absent(runId) && absent(publicationAttempt)) return null
  const valid = (value) =>
    (typeof value === "number" && positive(value)) ||
    (typeof value === "string" && /^[1-9]\d*$/.test(value) && positive(Number(value)))
  if (!valid(runId) || !valid(publicationAttempt))
    throw new Error("Source build run ID and publication attempt must both be positive safe integers")
  return {runId: Number(runId), publicationAttempt: Number(publicationAttempt)}
}

function firstExecution(all, job) {
  return Math.min(
    job.run_attempt,
    ...all
      .filter(
        (entry) =>
          entry.name === job.name &&
          positive(entry.run_attempt) &&
          entry.started_at &&
          entry.completed_at &&
          entry.started_at === job.started_at &&
          entry.completed_at === job.completed_at &&
          entry.conclusion === job.conclusion,
      )
      .map((entry) => entry.run_attempt),
  )
}

/** A notification retry can retain a successful publication from an earlier attempt. */
export function successfulMacPublication(run, all) {
  const latest = (name) =>
    all
      .filter((job) => job.name === name && positive(job.run_attempt) && job.run_attempt <= run.run_attempt)
      .sort((a, b) => b.run_attempt - a.run_attempt || b.id - a.id)[0]
  const build = latest("build")
  const publish = latest("publish")
  if (
    !positive(run.run_attempt) ||
    !build ||
    !publish ||
    [build, publish].some((job) => job.status !== "completed" || job.conclusion !== "success") ||
    build.run_attempt > publish.run_attempt ||
    (run.status !== "completed" && publish.run_attempt < run.run_attempt)
  )
    return null
  return {buildAttempt: firstExecution(all, build), publicationAttempt: firstExecution(all, publish)}
}

export async function jsonArtifact(url, fetchImpl) {
  const response = await fetchImpl(url, {redirect: "error", signal: AbortSignal.timeout(30_000)})
  if (!response.ok) throw new Error(`Published metadata unavailable (HTTP ${response.status})`)
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Published metadata has no body")
  const chunks = []
  let size = 0
  try {
    while (true) {
      const {done, value} = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 1024 * 1024) throw new Error("Published metadata exceeds 1 MiB")
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel()
  }
  const bytes = Buffer.concat(chunks)
  return {value: JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)), url, sha256: hash(bytes), size}
}

function prIdentity(pr, baseSha) {
  if (!positive(pr.number) || !SHA.test(pr.head?.sha ?? "") || !SHA.test(baseSha))
    throw new Error("GitHub returned incomplete PR identity")
  return {
    number: pr.number,
    url: pr.html_url,
    headSha: pr.head.sha,
    baseSha,
    headRepository: pr.head.repo?.full_name ?? null,
    baseRef: pr.base.ref,
  }
}

function verifiedApp(receipt, pr, attempts, otaManifestUrl) {
  const app = receipt.app
  if (
    !app ||
    app.pr !== pr.number ||
    app.headSha !== pr.head.sha ||
    app.buildSha !== receipt.buildSha ||
    app.runId !== receipt.runId ||
    app.runAttempt !== attempts.buildAttempt ||
    (receipt.buildAttempt ?? receipt.runAttempt) !== attempts.buildAttempt ||
    app.bundleId !== "com.mentra.mentra" ||
    app.teamId !== "T5XXXL6N36" ||
    app.backend !== "dev" ||
    app.otaManifestUrl !== otaManifestUrl ||
    !HASH.test(app.executableSha256 ?? "") ||
    !HASH.test(app.javascriptSha256 ?? "") ||
    typeof app.build !== "string" ||
    !/^\d+$/.test(app.build) ||
    typeof app.version !== "string" ||
    !app.version
  )
    throw new Error("Mac app identity or its packaged OTA pin disagrees with the producing build")
  return Object.fromEntries(
    [
      "pr",
      "headSha",
      "buildSha",
      "runId",
      "runAttempt",
      "bundleId",
      "teamId",
      "backend",
      "version",
      "build",
      "executableSha256",
      "javascriptSha256",
      "otaManifestUrl",
      "mobileFingerprint",
      "mobileSourceCommit",
      "reusedCompilation",
      "macPackageVersion",
      "macInstaller",
      "profileUUID",
      "profileExpires",
    ]
      .filter((key) => app[key] !== undefined)
      .map((key) => [key, app[key]]),
  )
}

/** Resolve only. This never downloads/executes a PR archive, sends a comment, or controls hardware. */
export async function createRoutineRequest({
  github,
  context,
  number,
  channel = "pr",
  routine = "day1-ota",
  requestOrigin,
  source,
  sourceBuildRunId,
  sourcePublicationAttempt,
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  if (channel !== "pr") {
    const {createCoordinatedRoutineRequest} = await import("./coordinated-routine-request.mjs")
    return createCoordinatedRoutineRequest({github, context, number, channel, routine, requestOrigin, source,
      sourceBuildRunId, sourcePublicationAttempt, fetchImpl, now})
  }
  const repository = `${context.repo.owner}/${context.repo.repo}`
  const selectedSource = sourcePublication(sourceBuildRunId, sourcePublicationAttempt)
  const registered = deviceRoutine(routine)
  if (!positive(number)) throw new Error("Expected a positive PR number")
  const authorization = requestOrigin ?? (context.eventName === "pull_request" ? "pr-label" : "workflow-dispatch")
  if (!["pr-label", "workflow-dispatch"].includes(authorization) ||
    (context.eventName === "pull_request" && authorization !== "pr-label"))
    throw new Error("Unsupported routine request authorization")
  const labelRequired = authorization === "pr-label"
  if (
    repository !== "Mentra-Community/MentraOS" ||
    !positive(context.runId) ||
    !positive(source.runAttempt) ||
    !SHA.test(source.sha ?? "") ||
    !SHA.test(source.workflowSha ?? "") ||
    source.workflowRef !== `${repository}/${REQUEST_WORKFLOW}@${source.ref}` ||
    !["workflow_dispatch", "pull_request"].includes(context.eventName)
  )
    throw new Error("Unsupported routine request source")
  if (context.eventName === "workflow_dispatch" && source.ref !== "refs/heads/dev")
    throw new Error("Stable manual requests must use the trusted dev workflow")
  if (selectedSource && context.eventName !== "workflow_dispatch")
    throw new Error("Source publication selectors require the trusted dev workflow dispatch")
  if (
    context.eventName === "pull_request" &&
    (source.ref !== `refs/pull/${number}/merge` || context.payload.pull_request?.number !== number)
  )
    throw new Error("Bootstrap request does not match its PR merge checkout")
  const getPr = async () => (await github.rest.pulls.get({...context.repo, pull_number: number})).data
  // pulls.get().base.sha may lag the branch tip even when GitHub has rebuilt the merge ref.
  const getBaseSha = async () => {
    const {data} = await github.rest.git.getRef({...context.repo, ref: "heads/dev"})
    if (data.ref !== "refs/heads/dev" || data.object?.type !== "commit" || !SHA.test(data.object.sha ?? ""))
      throw new Error("GitHub returned an invalid dev branch ref")
    return data.object.sha
  }
  const pr = await getPr()
  const baseSha = await getBaseSha()
  const request = {
    schemaVersion: 1,
    kind: "mentra-routine-request",
    requestId: `routine-${context.runId}-${source.runAttempt}-${number}-${routine}`,
    createdAt: now().toISOString(),
    status: "no-artifact",
    reason: "No eligible published Mac artifact for the current PR revision",
    trigger: {kind: context.eventName, repository, workflow: REQUEST_WORKFLOW, runId: context.runId, ...source},
    pullRequest: prIdentity(pr, baseSha),
    routine: {
      id: routine,
      authorization,
      reason:
        authorization === "workflow-dispatch"
          ? "Explicit workflow_dispatch opt-in"
          : `Explicit ${registered.label} PR label`,
      harnessRevision: source.sha,
    },
    selection: null,
    attempts: [],
  }
  if (pr.state !== "open" || pr.head.repo?.full_name !== repository || pr.base.ref !== "dev") {
    request.reason = "Only open same-repository PRs targeting dev are eligible"
    return request
  }
  if (
    context.eventName === "pull_request" &&
    (context.payload.pull_request.head.sha !== pr.head.sha ||
      context.payload.pull_request.base.ref !== pr.base.ref ||
      !hasRoutineLabel(pr, routine))
  ) {
    request.reason = "Bootstrap opt-in was removed or its triggering PR revision was superseded"
    return request
  }
  if (labelRequired && !hasRoutineLabel(pr, routine)) {
    request.reason = "Automatic request opt-in was removed"
    return request
  }
  let candidates
  if (selectedSource) {
    // A delayed callback must resolve its original publication, never whichever
    // newer run/attempt happens to exist when this request starts.
    request.reason = "Selected Mac publication is unavailable or does not match the current PR revision"
    let run
    try {
      run = (await github.rest.actions.getWorkflowRunAttempt({
        ...context.repo, run_id: selectedSource.runId, attempt_number: selectedSource.publicationAttempt,
      })).data
    } catch (error) {
      if (error?.status === 404) return request
      throw error
    }
    if (run.id !== selectedSource.runId || run.run_attempt !== selectedSource.publicationAttempt ||
      run.status !== "completed" || run.repository?.full_name !== repository ||
      !matchingBuildRun([run], pr, pr.head.sha)) return request
    candidates = [run]
  } else {
    const {data} = await github.rest.actions.listWorkflowRuns({
      ...context.repo,
      workflow_id: PRODUCER,
      head_sha: pr.head.sha,
      event: "pull_request",
      per_page: 100,
    })
    candidates = data.workflow_runs
  }
  while (candidates.length) {
    const run = matchingBuildRun(candidates, pr, pr.head.sha)
    if (!run) break
    candidates = candidates.filter((entry) => entry.id !== run.id)
    const candidate = {runId: run.id, reason: "Build/publication has not completed successfully"}
    request.attempts.push(candidate)
    try {
      if (run.path !== `.github/workflows/${PRODUCER}` || !positive(run.id))
        throw new Error("Unexpected Mac producer identity")
      const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
        ...context.repo,
        run_id: run.id,
        filter: "all",
        per_page: 100,
      })
      const attempts = successfulMacPublication(run, jobs)
      if (!attempts) continue
      if (selectedSource && attempts.publicationAttempt !== selectedSource.publicationAttempt) {
        candidate.reason = "Selected attempt retained another publication; no substitute was selected"
        continue
      }
      const receiptUrl = artifactUrl(
        repository,
        "pr-builds",
        iosReceiptName(number, pr.head.sha, run.id, attempts.publicationAttempt),
      )
      const receipt = await jsonArtifact(receiptUrl, fetchImpl)
      const assets = validateIosReceipt(receipt.value, {
        pr: number,
        sha: pr.head.sha,
        runId: run.id,
        attempt: attempts.publicationAttempt,
      })
      const otaUrl = artifactUrl(repository, "pr-builds", `ota-pr-${number}-${pr.head.sha}.json`)
      const app = verifiedApp(receipt.value, pr, attempts, otaUrl)
      const commit = (await github.rest.repos.getCommit({...context.repo, ref: receipt.value.buildSha})).data
      if (
        commit.sha !== receipt.value.buildSha ||
        commit.parents?.length !== 2 ||
        commit.parents[0].sha !== baseSha ||
        commit.parents[1].sha !== pr.head.sha
      )
        throw new Error("Mac build is not the current PR head merged with its current base")
      const archive = {url: artifactUrl(repository, "pr-builds", assets.mac.name), ...assets.mac}
      const available = await fetchImpl(archive.url, {
        method: "HEAD",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      })
      if (!available.ok || Number(available.headers.get("content-length")) !== archive.size)
        throw new Error("Published Mac archive is missing or its size differs from the receipt")
      const ota = await jsonArtifact(otaUrl, fetchImpl)
      readOtaTargets(ota.value, number, pr.head.sha)
      request.selection = {
        platform: "ios-on-mac",
        producer: {workflow: `.github/workflows/${PRODUCER}`, runId: run.id, ...attempts, url: run.html_url},
        receipt: {url: receipt.url, sha256: receipt.sha256, size: receipt.size},
        app,
        archive,
        otaManifest: {url: ota.url, sha256: ota.sha256, size: ota.size},
        build: {headSha: pr.head.sha, baseSha, buildSha: receipt.value.buildSha},
      }
      candidate.reason = "Verified published Mac receipt, archive availability, OTA pin and merge provenance"
      break
    } catch (error) {
      candidate.reason = error instanceof Error ? error.message : String(error)
    }
  }
  const current = await getPr()
  const currentBaseSha = await getBaseSha()
  if (
    current.state !== "open" ||
    current.head.sha !== pr.head.sha ||
    current.head.repo?.full_name !== repository ||
    current.base.ref !== "dev" ||
    currentBaseSha !== baseSha ||
    (labelRequired && !hasRoutineLabel(current, routine))
  ) {
    request.selection = null
    request.reason = "PR head/base or opt-in changed while resolving; no candidate was queued"
  } else if (request.selection) {
    request.status = "ready"
    request.reason = "Exact current PR Mac build selected; hardware qualification has not run"
  } else if (request.attempts.length) request.reason = request.attempts[0].reason
  return request
}

export async function writeRoutineRequest(directory, request) {
  await mkdir(directory, {recursive: true})
  const path = join(directory, "request.json")
  await writeFile(path, JSON.stringify(request, null, 2) + "\n", {flag: "wx", mode: 0o600})
  return path
}
