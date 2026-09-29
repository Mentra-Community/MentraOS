import {createHash} from "node:crypto"
import {mkdir, readFile, writeFile} from "node:fs/promises"
import {readActionsJson} from "./release-routine-slack.mjs"

const REPOSITORY = "Mentra-Community/MentraOS"
const SHA = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const positive = value => Number.isSafeInteger(value) && value > 0
const ensure = (value, message) => { if (!value) throw new Error(message) }
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...names].sort().join(",")
export const HARNESS_VERIFICATION_STEP = "Publish harness verification constraint"
export const harnessVerificationName = (runId, attempt) => `mentra-harness-verification-${runId}-${attempt}`

/** A restrictive companion, never an extension to the legacy worker's request.json. */
export function harnessVerificationConstraint(requestBytes, expectedHarnessSha) {
  ensure(SHA.test(expectedHarnessSha ?? "") && typeof expectedHarnessSha === "string" && requestBytes.byteLength <= 1024 * 1024, "Invalid harness verification input")
  const request = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(requestBytes))
  const trigger = request.trigger
  ensure(trigger?.repository === REPOSITORY && trigger.kind === "workflow_dispatch" &&
    trigger.workflow === ".github/workflows/request-e2e-routine.yml" && trigger.ref === "refs/heads/dev" &&
    positive(trigger.runId) && positive(trigger.runAttempt) && typeof request.routine?.id === "string",
  "Harness constraint requires a trusted request identity")
  return {schemaVersion: 1, kind: "mentra-harness-verification", request: {
    repository: REPOSITORY, runId: trigger.runId, runAttempt: trigger.runAttempt, routineId: request.routine.id,
    sha256: createHash("sha256").update(requestBytes).digest("hex"),
  }, expectedHarnessSha}
}
export async function writeHarnessVerification(expectedHarnessSha) {
  const value = harnessVerificationConstraint(await readFile("routine-request/request.json"), expectedHarnessSha)
  await mkdir("harness-verification", {recursive: true})
  await writeFile("harness-verification/constraint.json", `${JSON.stringify(value)}\n`)
}

/** Authenticated exact-attempt step history prevents deleting the companion from
 * silently downgrading a constrained request to an ordinary one. */
export async function harnessVerificationArtifact(github, repo, run, artifacts) {
  const jobs = []
  let total
  for (let page = 1; page <= 10; page++) {
    const {data} = await github.rest.actions.listJobsForWorkflowRunAttempt({...repo,
      run_id: run.id, attempt_number: run.run_attempt, per_page: 100, page})
    ensure(Number.isSafeInteger(data.total_count) && data.total_count > 0 && data.total_count < 1000 && Array.isArray(data.jobs),
      "Request step history is incomplete")
    total ??= data.total_count
    ensure(total === data.total_count, "Request step history changed")
    jobs.push(...data.jobs)
    if (jobs.length >= total) break
    ensure(data.jobs.length === 100, "Request step history is incomplete")
  }
  ensure(jobs.length === total && new Set(jobs.map(job => job.id)).size === jobs.length && jobs.every(job =>
    positive(job.id) && job.run_id === run.id && job.run_attempt === run.run_attempt && job.head_sha === run.head_sha && job.status === "completed" && Array.isArray(job.steps)),
  "Request step history is not bound to this completed attempt")
  const steps = jobs.flatMap(job => job.steps).filter(step => step.name === HARNESS_VERIFICATION_STEP)
  ensure(steps.length <= 1 && steps.every(step => step.status === "completed" && ["success", "skipped"].includes(step.conclusion)),
    "Harness constraint publication is ambiguous or incomplete")
  const required = steps.length === 1 && steps[0].conclusion === "success"
  ensure(artifacts.length < 1000 && new Set(artifacts.map(item => item.id)).size === artifacts.length, "Artifact history is incomplete")
  const matching = artifacts.filter(item => item.name === harnessVerificationName(run.id, run.run_attempt))
  if (!required) {
    ensure(matching.length === 0, "Unexpected harness constraint without successful publication")
    return null
  }
  ensure(matching.length === 1, "Required harness constraint is missing or ambiguous")
  const artifact = matching[0]
  ensure(positive(artifact.id) && !artifact.expired && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 16 * 1024 &&
    /^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "") && artifact.workflow_run?.id === run.id &&
    artifact.workflow_run.head_sha === run.head_sha, "Harness constraint artifact is not bound to its producer")
  return artifact
}

export function validateHarnessVerification(value, requestBytes, run, routineId) {
  ensure(keys(value, ["schemaVersion", "kind", "request", "expectedHarnessSha"]) && value.schemaVersion === 1 &&
    value.kind === "mentra-harness-verification" && SHA.test(value.expectedHarnessSha ?? "") &&
    keys(value.request, ["repository", "runId", "runAttempt", "routineId", "sha256"]) &&
    Buffer.byteLength(JSON.stringify(value)) <= 8192, "Invalid harness constraint")
  const request = value.request
  ensure(request.repository === REPOSITORY && request.runId === run.id && request.runAttempt === run.run_attempt &&
    request.routineId === routineId && HASH.test(request.sha256 ?? "") &&
    request.sha256 === createHash("sha256").update(requestBytes).digest("hex"), "Harness constraint does not match the exact request")
  return value.expectedHarnessSha
}

export async function readHarnessVerification(github, repo, run, requestBytes, routineId) {
  // Existing reader authenticates the ZIP digest, disallows other filenames and never extracts files.
  const values = await readActionsJson(github, repo, run, harnessVerificationName(run.id, run.run_attempt), ["constraint.json"], {maxJsonBytes: 8192})
  return validateHarnessVerification(values["constraint.json"], requestBytes, run, routineId)
}
