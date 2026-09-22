import {createHash, randomUUID} from "node:crypto"
import {constants} from "node:fs"
import {lstat, mkdir, open, unlink} from "node:fs/promises"
import {join, resolve} from "node:path"

export const REQUEST_REPOSITORY = "Mentra-Community/MentraOS"
export const REQUEST_WORKFLOW = ".github/workflows/request-e2e-routine.yml"
export const REQUEST_LABEL = "routine:day1-ota"
const SHA = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const CDN = `https://artifactscdn.mentraglass.com/${REQUEST_REPOSITORY}/releases/pr-builds/`
type Row = Record<string, unknown>
type TriggerKind = "pull_request" | "workflow_dispatch"

export interface RoutineRequest {
  schemaVersion: 1
  kind: "mentra-routine-request"
  requestId: string
  createdAt: string
  status: "ready" | "no-artifact"
  reason: string
  trigger: {
    kind: TriggerKind
    repository: string
    workflow: string
    runId: number
    runAttempt: number
    ref: string
    sha: string
    workflowSha: string
    workflowRef: string
    actor: string
  }
  pullRequest: {number: number; url: string; headSha: string; baseSha: string; headRepository: string; baseRef: string}
  routine: {id: "day1-ota"; reason: string; harnessRevision: string}
  selection: null | {
    platform: "ios-on-mac"
    producer: {workflow: string; runId: number; buildAttempt: number; publicationAttempt: number; url: string}
    receipt: {url: string; sha256: string; size: number}
    archive: {url: string; name: string; sha256: string; size: number}
    otaManifest: {url: string; sha256: string; size: number}
    app: Row
    build: {headSha: string; baseSha: string; buildSha: string}
  }
  attempts: {runId: number; reason: string}[]
}

export interface RequestTrust {
  schemaVersion: 1
  repository: typeof REQUEST_REPOSITORY
  entries: {kind: TriggerKind; pr: number; headSha: string; baseSha: string; sourceSha: string; workflowSha: string}[]
}

export interface RequestEvidence {
  run: {
    id: number
    run_attempt: number
    event: string
    path: string
    head_sha: string
    head_branch: string
    status: string
    conclusion: string
    repository: {full_name: string}
    head_repository: {full_name: string}
  }
  artifact: {
    id: number
    name: string
    size_in_bytes: number
    digest: string
    expired: boolean
    workflow_run: {id: number; head_sha: string}
  }
  archiveSha256: string
  sourceCommit: {sha: string; parents: {sha: string}[]}
  currentPr: {
    number: number
    state: string
    head: {sha: string; ref: string; repo: {full_name: string}}
    base: {sha: string; ref: string}
    labels: {name: string}[]
  }
}

export function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}
function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}
function text(value: unknown, name: string, pattern?: RegExp): asserts value is string {
  requireThat(
    typeof value === "string" && value.length > 0 && value.length <= 4096 && (!pattern || pattern.test(value)),
    `${name} is invalid`,
  )
}
function object(value: unknown, name: string, keys?: string[]): Row {
  requireThat(value && typeof value === "object" && !Array.isArray(value), `${name} must be an object`)
  const row = value as Row
  requireThat(!keys || Object.keys(row).every((key) => keys.includes(key)), `${name} contains unsupported fields`)
  return row
}
function parse(bytes: Uint8Array): unknown {
  requireThat(bytes.byteLength <= 1024 * 1024, "Request metadata exceeds 1 MiB")
  return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes))
}
function artifact(value: unknown, name: string, expectedUrl: string, archive = false) {
  const row = object(value, name, archive ? ["url", "sha256", "size", "name"] : ["url", "sha256", "size"])
  requireThat(row.url === expectedUrl && positive(row.size), `${name} URL or size is invalid`)
  text(row.sha256, `${name} hash`, HASH)
  return row
}

/** Parse data only; no field in this contract names executable code or a host command. */
export function parseRoutineRequest(bytes: Uint8Array): RoutineRequest {
  const row = object(parse(bytes), "Request", [
    "schemaVersion",
    "kind",
    "requestId",
    "createdAt",
    "status",
    "reason",
    "trigger",
    "pullRequest",
    "routine",
    "selection",
    "attempts",
  ])
  requireThat(row.schemaVersion === 1 && row.kind === "mentra-routine-request", "Unsupported request schema")
  text(row.createdAt, "Request creation time")
  requireThat(Number.isFinite(Date.parse(row.createdAt)), "Invalid request creation time")
  text(row.reason, "Request reason")
  const trigger = object(row.trigger, "Trigger", [
    "kind",
    "repository",
    "workflow",
    "runId",
    "runAttempt",
    "ref",
    "sha",
    "workflowSha",
    "workflowRef",
    "actor",
  ])
  requireThat(
    trigger.repository === REQUEST_REPOSITORY &&
      trigger.workflow === REQUEST_WORKFLOW &&
      ["pull_request", "workflow_dispatch"].includes(String(trigger.kind)) &&
      positive(trigger.runId) &&
      positive(trigger.runAttempt),
    "Unsupported request trigger",
  )
  text(trigger.sha, "Checkout SHA", SHA)
  text(trigger.workflowSha, "Workflow SHA", SHA)
  text(trigger.actor, "Trigger actor")
  const pr = object(row.pullRequest, "PR", ["number", "url", "headSha", "baseSha", "headRepository", "baseRef"])
  requireThat(
    positive(pr.number) &&
      pr.headRepository === REQUEST_REPOSITORY &&
      pr.baseRef === "dev" &&
      pr.url === `https://github.com/${REQUEST_REPOSITORY}/pull/${pr.number}`,
    "Unsupported PR identity",
  )
  text(pr.headSha, "PR head", SHA)
  text(pr.baseSha, "PR base", SHA)
  requireThat(
    trigger.ref === (trigger.kind === "pull_request" ? `refs/pull/${pr.number}/merge` : "refs/heads/dev") &&
      trigger.workflowRef === `${REQUEST_REPOSITORY}/${REQUEST_WORKFLOW}@${trigger.ref}`,
    "Workflow ref does not match its event",
  )
  requireThat(
    row.requestId === `routine-${trigger.runId}-${trigger.runAttempt}-${pr.number}-day1-ota`,
    "Request ID does not match its immutable generation",
  )
  const routine = object(row.routine, "Routine", ["id", "reason", "harnessRevision"])
  requireThat(
    routine.id === "day1-ota" && routine.harnessRevision === trigger.sha,
    "Unsupported routine or source revision",
  )
  text(routine.reason, "Routine reason")
  requireThat(Array.isArray(row.attempts) && row.attempts.length <= 100, "Invalid candidate attempts")
  for (const item of row.attempts) {
    const attempt = object(item, "Candidate attempt", ["runId", "reason"])
    requireThat(positive(attempt.runId), "Invalid candidate run")
    text(attempt.reason, "Candidate reason")
  }
  requireThat(row.status === "ready" || row.status === "no-artifact", "Unsupported request status")
  if (row.status === "no-artifact")
    requireThat(row.selection === null, "No-artifact requests cannot carry a selected build")
  else {
    const selected = object(row.selection, "Selection", [
      "platform",
      "producer",
      "receipt",
      "archive",
      "otaManifest",
      "app",
      "build",
    ])
    const producer = object(selected.producer, "Producer", [
      "workflow",
      "runId",
      "buildAttempt",
      "publicationAttempt",
      "url",
    ])
    requireThat(
      selected.platform === "ios-on-mac" &&
        producer.workflow === ".github/workflows/mentra-app-ios-build.yml" &&
        positive(producer.runId) &&
        positive(producer.buildAttempt) &&
        positive(producer.publicationAttempt) &&
        producer.buildAttempt <= producer.publicationAttempt &&
        producer.url === `https://github.com/${REQUEST_REPOSITORY}/actions/runs/${producer.runId}`,
      "Invalid Mac producer",
    )
    const suffix = `pr-${pr.number}-${pr.headSha}-${producer.runId}`
    artifact(selected.receipt, "Receipt", `${CDN}mentra-ios-${suffix}-${producer.publicationAttempt}.json`)
    const archive = artifact(
      selected.archive,
      "Mac archive",
      `${CDN}mentra-ios-mac-${suffix}-${producer.buildAttempt}.zip`,
      true,
    )
    requireThat(
      archive.name === `mentra-ios-mac-${suffix}-${producer.buildAttempt}.zip`,
      "Mac archive name disagrees with producer",
    )
    const ota = artifact(selected.otaManifest, "OTA manifest", `${CDN}ota-pr-${pr.number}-${pr.headSha}.json`)
    const build = object(selected.build, "Build", ["headSha", "baseSha", "buildSha"])
    requireThat(build.headSha === pr.headSha && build.baseSha === pr.baseSha, "Build revision disagrees with PR")
    text(build.buildSha, "Build SHA", SHA)
    const app = object(selected.app, "App", [
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
    ])
    requireThat(
      app.pr === pr.number &&
        app.headSha === pr.headSha &&
        app.buildSha === build.buildSha &&
        app.runId === producer.runId &&
        app.runAttempt === producer.buildAttempt &&
        app.bundleId === "com.mentra.mentra" &&
        app.teamId === "T5XXXL6N36" &&
        app.backend === "dev" &&
        app.otaManifestUrl === ota.url,
      "App identity disagrees with selected build",
    )
    text(app.build, "App build", /^\d+$/)
    text(app.version, "App version")
    text(app.executableSha256, "App executable hash", HASH)
    text(app.javascriptSha256, "App JavaScript hash", HASH)
  }
  return row as unknown as RoutineRequest
}

export function parseRequestTrust(bytes: Uint8Array): RequestTrust {
  const row = object(parse(bytes), "Private trust policy", ["schemaVersion", "repository", "entries"])
  requireThat(
    row.schemaVersion === 1 &&
      row.repository === REQUEST_REPOSITORY &&
      Array.isArray(row.entries) &&
      row.entries.length > 0 &&
      row.entries.length <= 128,
    "Invalid private trust policy",
  )
  for (const value of row.entries) {
    const entry = object(value, "Trusted request source", [
      "kind",
      "pr",
      "headSha",
      "baseSha",
      "sourceSha",
      "workflowSha",
    ])
    requireThat(
      ["pull_request", "workflow_dispatch"].includes(String(entry.kind)) && positive(entry.pr),
      "Invalid trusted PR/event",
    )
    for (const key of ["headSha", "baseSha", "sourceSha", "workflowSha"]) text(entry[key], `Trusted ${key}`, SHA)
  }
  return row as unknown as RequestTrust
}

/** GitHub API observations come from the worker, never from the request archive. */
export function assertRequestTrust(request: RoutineRequest, trust: RequestTrust, evidence: RequestEvidence): void {
  const {trigger, pullRequest: selectedPr} = request
  const {run, artifact, currentPr: pr, sourceCommit} = evidence
  requireThat(
    run.repository?.full_name === REQUEST_REPOSITORY &&
      run.head_repository?.full_name === REQUEST_REPOSITORY &&
      run.id === trigger.runId &&
      run.run_attempt === trigger.runAttempt &&
      run.path === REQUEST_WORKFLOW &&
      run.event === trigger.kind &&
      run.status === "completed" &&
      run.conclusion === "success",
    "Authenticated workflow run does not match this request",
  )
  requireThat(
    positive(artifact.id) &&
      !artifact.expired &&
      artifact.name === `mentra-routine-request-${run.id}-${run.run_attempt}` &&
      artifact.workflow_run?.id === run.id &&
      artifact.workflow_run.head_sha === run.head_sha &&
      artifact.digest === `sha256:${evidence.archiveSha256}` &&
      HASH.test(evidence.archiveSha256),
    "Actions artifact identity or downloaded ZIP digest does not match",
  )
  requireThat(
    pr.number === selectedPr.number &&
      pr.state === "open" &&
      pr.head.repo.full_name === REQUEST_REPOSITORY &&
      pr.head.sha === selectedPr.headSha &&
      pr.base.sha === selectedPr.baseSha &&
      pr.base.ref === "dev",
    "Request was superseded or no longer targets an eligible PR",
  )
  requireThat(
    trust.entries.some(
      (entry) =>
        entry.kind === trigger.kind &&
        entry.pr === pr.number &&
        entry.headSha === pr.head.sha &&
        entry.baseSha === pr.base.sha &&
        entry.sourceSha === trigger.sha &&
        entry.workflowSha === trigger.workflowSha,
    ),
    "Source/head SHAs are not explicitly trusted by this worker",
  )
  requireThat(
    sourceCommit.sha === trigger.sha && trigger.workflowSha === trigger.sha,
    "Workflow and checkout source must be the same approved commit",
  )
  if (trigger.kind === "pull_request") {
    requireThat(
      run.head_sha === pr.head.sha &&
        run.head_branch === pr.head.ref &&
        pr.labels.some((label) => label.name === REQUEST_LABEL),
      "Bootstrap run head or current PR opt-in does not match",
    )
    requireThat(
      sourceCommit.parents.length === 2 &&
        sourceCommit.parents[0]?.sha === pr.base.sha &&
        sourceCommit.parents[1]?.sha === pr.head.sha,
      "Bootstrap checkout is not the approved base/head merge",
    )
  } else
    requireThat(
      run.head_sha === trigger.sha && run.head_branch === "dev",
      "Manual request did not run from the approved dev revision",
    )
}

export interface IntakeResult {
  schemaVersion: 1
  requestId: string
  status: "no-artifact" | "blocked-unqualified" | "already-claimed"
  reason: string
  hardwareStarted: false
  at: string
}

async function directory(path: string) {
  await mkdir(path, {recursive: true, mode: 0o700})
  const stat = await lstat(path)
  requireThat(
    stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o022),
    "Worker state directory must be private and not a symlink",
  )
}
async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
async function durableExclusive(path: string, value: unknown) {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n")
    await handle.sync()
  } finally {
    await handle.close()
  }
}
function exists(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST"
}

/** The local registry is deliberately closed until the day-one hardware adapter is qualified. */
function dispatchRegisteredRoutine(request: RoutineRequest): IntakeResult {
  requireThat(request.routine.id === "day1-ota", "No registered routine for this request")
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    status: request.status === "no-artifact" ? "no-artifact" : "blocked-unqualified",
    reason:
      request.status === "no-artifact"
        ? request.reason
        : "Day-one OTA hardware adapter is not qualified; no installation, downgrade or update was started",
    hardwareStarted: false,
    at: new Date().toISOString(),
  }
}

/** A partial claim or retained worker lease requires operator reconciliation, never automatic retry. */
export async function consumeRoutineRequest(
  request: RoutineRequest,
  evidence: RequestEvidence,
  trust: RequestTrust,
  stateDirectory: string,
): Promise<IntakeResult> {
  // Revalidate at the filesystem boundary even when called outside the CLI.
  request = parseRoutineRequest(Buffer.from(JSON.stringify(request)))
  assertRequestTrust(request, trust, evidence)
  const root = resolve(stateDirectory)
  await directory(root)
  const claims = join(root, "claims")
  await directory(claims)
  const claim = join(claims, `${request.requestId}.json`)
  try {
    await lstat(claim)
    return {
      schemaVersion: 1,
      requestId: request.requestId,
      status: "already-claimed",
      reason:
        "This request has a durable claim. Read its result or reconcile its interrupted processing; it will not be dispatched again",
      hardwareStarted: false,
      at: new Date().toISOString(),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const lease = join(root, "worker-lease.json")
  try {
    await durableExclusive(lease, {
      schemaVersion: 1,
      token: randomUUID(),
      requestId: request.requestId,
      pid: process.pid,
      at: new Date().toISOString(),
    })
    await syncDirectory(root)
  } catch (error) {
    if (exists(error))
      throw new Error("Worker lease exists; reconcile the previous worker before consuming another request")
    throw error
  }
  // Do not release the lease on an exception: the durable claim/result may be partial.
  await durableExclusive(claim, {schemaVersion: 1, request, evidence, at: new Date().toISOString()})
  await syncDirectory(claims)
  const result = dispatchRegisteredRoutine(request)
  await durableExclusive(join(claims, `${request.requestId}.result.json`), result)
  await syncDirectory(claims)
  await unlink(lease)
  await syncDirectory(root)
  return result
}
