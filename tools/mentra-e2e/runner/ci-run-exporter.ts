import {createHash} from "node:crypto"
import {mkdir, readdir, writeFile} from "node:fs/promises"
import {basename, dirname, join, relative, resolve} from "node:path"
import {isDeepStrictEqual} from "node:util"
import {testRunSchema, type TestRun} from "../../../cloud-v2/packages/core/src/types/test-run.types"
import {verifyBuildManifest} from "./build-manifest"
import {
  assertRequestTrust,
  parseRequestTrust,
  parseRoutineRequest,
  type VerifiedRoutineRegistration,
} from "./ci-request"
import {normalizeBesVersion} from "./firmware-profile"
import type {AssertionObservation, Json, LifecycleEvent, LifecycleResult, LifecycleState} from "./lifecycle"
import {normalizeFirmware} from "./ota-state"
import {child, copyRecordedEvidence, hash, noLinks, stableBytes, type ChapterPhase} from "./recorded-evidence"
import {MAX_ASSET_BYTES, MAX_METADATA_BYTES, object, requireThat, type TestRunAsset} from "./test-run-record"

type Row = Record<string, any>
export interface FrozenFile {
  path: string
  sha256: string
}
export interface CiExportInputs {
  claim: FrozenFile
  trust: FrozenFile
}
const HASH = /^[a-f0-9]{64}$/
const SHA = /^[a-f0-9]{40}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/
const PHASES = [
  "preflight",
  "setup",
  "test",
  "final-assertions",
  "teardown",
  "return-verification",
  "evidence",
] as const
const VERDICTS = ["not-run", "passed", "failed", "cancelled", "deferred"]
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n")
const equal = (a: unknown, b: unknown, reason: string) => requireThat(isDeepStrictEqual(a, b), reason)
function validVersion(value: unknown, normalize: (value: string) => string) {
  if (typeof value !== "string") return false
  try {
    normalize(value)
    return true
  } catch {
    return false
  }
}
const FIRMWARE_CHECKS: Record<string, {component: string; valid: (value: unknown) => boolean}> = {
  "firmware.mtk": {
    component: "MTK version",
    valid: (v) => validVersion(v, normalizeFirmware),
  },
  "firmware.asg.version": {
    component: "ASG version",
    valid: (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0,
  },
  "firmware.asg.active-apk": {
    component: "ASG APK SHA-256",
    valid: (v) => typeof v === "string" && HASH.test(v),
  },
  "firmware.bes.version": {
    component: "BES version",
    valid: (v) => validVersion(v, normalizeBesVersion),
  },
}
/** Called only after verifying the consumed claim and complete lifecycle journal.
 * Copy the collector's four public comparisons, never identity, logs or arbitrary
 * nested payloads. Identical observations in one phase need one row; a later
 * success cannot replace an earlier failure or a check from a different phase. */
function projectFirmwareAssertions(events: LifecycleEvent[]): TestRun["firmwareAssertions"] {
  const rows: TestRun["firmwareAssertions"] = [],
    seen = new Set<string>()
  for (const event of events) {
    if (event.type !== "assertion" && event.type !== "reconciliation") continue
    const actual = (event.details as Row)?.actual
    for (const checks of [actual?.firmwareAssertions, actual?.target?.firmwareAssertions]) {
      if (!Array.isArray(checks)) continue
      for (const check of checks) {
        const rule =
          typeof check?.id === "string" && Object.hasOwn(FIRMWARE_CHECKS, check.id)
            ? FIRMWARE_CHECKS[check.id]
            : undefined
        if (!rule) continue
        requireThat(rule.valid(check.expected), "Invalid expected firmware comparison")
        requireThat(["passed", "failed"].includes(check.status), "Invalid firmware comparison status")
        requireThat(
          check.status !== "passed" || rule.valid(check.actual),
          "Passed firmware comparison lacks a valid value",
        )
        const row = {
          phase: event.phase,
          component: rule.component,
          expected: String(check.expected),
          actual: rule.valid(check.actual)
            ? String(check.actual)
            : check.actual == null
              ? "Not observed"
              : "Invalid observation",
          status: check.status as "passed" | "failed",
        }
        const key = JSON.stringify(row)
        if (!seen.has(key)) {
          seen.add(key)
          rows.push(row)
        }
      }
    }
  }
  return rows
}
function time(value: unknown) {
  requireThat(
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) && Number.isFinite(Date.parse(value)),
    "Invalid evidence timestamp",
  )
  return Date.parse(value)
}
async function frozen(ref: FrozenFile, limit = 4 * MAX_METADATA_BYTES) {
  requireThat(
    ref && resolve(ref.path) === ref.path && HASH.test(ref.sha256),
    "Expected absolute hashed evidence reference",
  )
  const bytes = await stableBytes(ref.path, limit)
  requireThat(hash(bytes) === ref.sha256, "Frozen evidence hash mismatch")
  return {bytes, value: object(JSON.parse(bytes.toString()), "Evidence JSON") as Row}
}
async function loadClaim(inputs: CiExportInputs) {
  const claim = await frozen(inputs.claim),
    trust = await frozen(inputs.trust, MAX_METADATA_BYTES)
  const row = claim.value,
    request = parseRoutineRequest(json(row.request))
  assertRequestTrust(request, parseRequestTrust(trust.bytes), row.evidence)
  requireThat(
    row.schemaVersion === 1 && request.status === "ready" && request.selection && row.runID === request.requestId,
    "Expected a consumed ready CI request",
  )
  requireThat(row.requestSha256 === hash(Buffer.from(JSON.stringify(request))), "Claim request hash differs")
  const stateDirectory = dirname(dirname(inputs.claim.path))
  requireThat(
    dirname(inputs.claim.path) === join(stateDirectory, "claims") &&
      basename(inputs.claim.path) === `${request.requestId}.json` &&
      row.runDirectory === join(stateDirectory, "runs", row.runID),
    "Claim is outside the worker's durable layout",
  )
  const registration = object(row.registration, "Registered routine") as unknown as VerifiedRoutineRegistration
  requireThat(
    registration.routineId === request.routine.id &&
      registration.requestSha256 === row.requestSha256 &&
      SHA.test(registration.harnessRevision) &&
      ID.test(registration.fixtureID),
    "Invalid claim registration",
  )
  for (const digest of [
    registration.definitionDigest,
    registration.qualificationDigest,
    registration.returnProfileDigest,
  ])
    requireThat(HASH.test(digest), "Missing registered definition/qualification/profile digest")
  requireThat(resolve(registration.fixtureDirectory) === registration.fixtureDirectory, "Invalid enrolled fixture path")
  time(row.at)
  return {claim, trust, row, request, registration, stateDirectory}
}
function binding(c: Awaited<ReturnType<typeof loadClaim>>, claimSha256: string) {
  return {
    schemaVersion: 1,
    requestId: c.request.requestId,
    runID: c.row.runID,
    claimSha256,
    requestSha256: c.row.requestSha256,
    harnessRevision: c.registration.harnessRevision,
    definitionDigest: c.registration.definitionDigest,
    qualificationDigest: c.registration.qualificationDigest,
    fixtureID: c.registration.fixtureID,
    returnProfileDigest: c.registration.returnProfileDigest,
  }
}
/** Attach this binding before starting the trusted registered recording. It is not an outcome. */
export async function ciRecordingBinding(inputs: CiExportInputs) {
  return binding(await loadClaim(inputs), inputs.claim.sha256)
}
function checkReport(run: Row, c: Awaited<ReturnType<typeof loadClaim>>, claimSha256: string) {
  requireThat(
    run.executionMode === "ci-registered" &&
      run.modelCalls === 0 &&
      run.evidenceVersion >= 2 &&
      ["passed", "failed", "incomplete"].includes(run.status) &&
      run.video?.event === "finished",
    "Expected a finalized registered CI recording, never manual discovery",
  )
  equal(run.ciLifecycle, binding(c, claimSha256), "Recording belongs to another claim/registration")
  requireThat(
    time(run.ended) >= time(run.started) &&
      time(run.started) >= time(c.row.at) &&
      Array.isArray(run.results) &&
      run.results.length > 0,
    "Recording time or steps are invalid",
  )
  requireThat(
    run.sourceReference === c.registration.harnessRevision && HASH.test(run.harnessHash) && HASH.test(run.driverHash),
    "Recording lacks actual registered harness identity",
  )
  const app = object(run.verifiedCiBuild, "Recorded CI build")
  verifyBuildManifest(app, {
    ...run.app,
    executableSha256: run.appExecutableHash,
    javascriptSha256: run.appJavascriptHash,
  })
  for (const [key, value] of Object.entries(c.request.selection!.app))
    equal(app[key], value, "Recording is from another selected CI app")
}
function phaseMap(run: Row, value: unknown): Record<string, ChapterPhase> {
  const map = object(value, "Recorded chapter phases") as Record<string, ChapterPhase>
  equal(
    Object.keys(map).sort(),
    run.results.map((s: Row) => s.id).sort(),
    "Every recorded step needs an explicit phase",
  )
  requireThat(
    Object.values(map).every((p) => ["setup", "test", "verify", "teardown"].includes(p)),
    "Invalid recorded chapter phase",
  )
  return map
}
async function harnessIdentity(directory: string) {
  const root = await noLinks(resolve(directory))
  const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], {cwd: root, stdout: "pipe", stderr: "ignore"})
  const revision = git.stdout.toString().trim()
  requireThat(git.exitCode === 0 && SHA.test(revision), "Cannot establish actual verifier harness revision")
  const digest = createHash("sha256")
  async function visit(path: string) {
    for (const entry of (await readdir(path, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules") continue
      const file = join(path, entry.name)
      requireThat(!entry.isSymbolicLink(), "Verifier harness must not contain symlinks")
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) digest.update(relative(root, file)).update(await stableBytes(file, MAX_ASSET_BYTES))
    }
  }
  await visit(root)
  return {revision, hash: digest.digest("hex")}
}

/** Evidence-phase assertion for a trusted local adapter, after Report.finish().
 * The adapter must have set executionMode/ciLifecycle before recording. This function cannot
 * promote a manual report: it copies only a bound finalized report, then runs the real verifier.
 * A failed product test can have valid evidence; passed here means artifact integrity only. */
export async function finalizeCiRecording(
  options: CiExportInputs & {
    reportDirectory: string
    harnessDirectory: string
    phaseByStep: Record<string, ChapterPhase>
  },
): Promise<AssertionObservation> {
  const c = await loadClaim(options),
    source = await noLinks(options.reportDirectory)
  const reportBytes = await stableBytes(join(source, "run.json"), 4 * MAX_METADATA_BYTES)
  const report = JSON.parse(reportBytes.toString()) as Row
  checkReport(report, c, options.claim.sha256)
  const phases = phaseMap(report, options.phaseByStep),
    harness = await harnessIdentity(options.harnessDirectory)
  requireThat(
    harness.revision === c.registration.harnessRevision && harness.hash === report.harnessHash,
    "Actual verifier harness differs from the recorded harness",
  )
  const destination = child(c.row.runDirectory, "recording")
  await noLinks(dirname(destination))
  await mkdir(destination, {mode: 0o700}) // Exclusive: retries cannot overwrite finalized evidence.
  const names = new Set(["run.json", "routine.mp4", "chapters.json", "index.html"])
  for (const step of report.results)
    if (!["not-run", "not-applicable"].includes(step.status)) {
      names.add(step.screenshot)
      names.add(step.accessibility)
    }
  const inventory: {path: string; sha256: string; size: number}[] = []
  for (const name of [...names].sort()) {
    const original = child(source, name),
      target = child(destination, name)
    const bytes = await stableBytes(original, name === "routine.mp4" ? MAX_ASSET_BYTES : 4 * MAX_METADATA_BYTES)
    await mkdir(dirname(target), {recursive: true, mode: 0o700})
    await writeFile(target, bytes, {flag: "wx", mode: 0o600})
    inventory.push({path: name, sha256: hash(bytes), size: bytes.length})
  }
  requireThat(
    inventory.find((f) => f.path === "run.json")?.sha256 === hash(reportBytes),
    "Report changed while freezing evidence",
  )
  const verifierPath = join(resolve(options.harnessDirectory), "verify-run.ts")
  const verifierSha256 = hash(await stableBytes(verifierPath, MAX_METADATA_BYTES))
  const verifier = Bun.spawn([process.execPath, verifierPath, destination], {stdout: "pipe", stderr: "ignore"})
  const timer = setTimeout(() => verifier.kill(), 30000)
  let checks: Row
  try {
    const [output, code] = await Promise.all([new Response(verifier.stdout).text(), verifier.exited])
    requireThat(
      code === 0 && Buffer.byteLength(output) <= MAX_METADATA_BYTES,
      "Registered recording integrity verification failed",
    )
    checks = object(JSON.parse(output), "Integrity result")
    requireThat(
      checks.artifactChecks === "passed" &&
        checks.frameLiveness === "verified" &&
        checks.status === report.status &&
        checks.executed > 0,
      "Incomplete recording integrity result",
    )
  } finally {
    clearTimeout(timer)
  }
  equal(await harnessIdentity(options.harnessDirectory), harness, "Verifier harness changed during verification")
  for (const file of inventory) {
    requireThat(
      hash(await stableBytes(child(destination, file.path), MAX_ASSET_BYTES)) === file.sha256 &&
        hash(await stableBytes(child(source, file.path), MAX_ASSET_BYTES)) === file.sha256,
      "Recording changed during integrity verification",
    )
  }
  const checkedAt = new Date().toISOString()
  const integrity = {
    schemaVersion: 1,
    kind: "ci-recording-integrity",
    binding: binding(c, options.claim.sha256),
    checkedAt,
    verifier: {harnessRevision: harness.revision, harnessHash: harness.hash, scriptSha256: verifierSha256},
    checks: {
      status: checks.status,
      executed: checks.executed,
      duration: checks.duration,
      width: checks.width,
      height: checks.height,
      artifactChecks: checks.artifactChecks,
      frameLiveness: checks.frameLiveness,
    },
    files: inventory,
  }
  const integrityBytes = json(integrity)
  await writeFile(join(destination, "integrity.json"), integrityBytes, {flag: "wx", mode: 0o600})
  const descriptor = {
    schemaVersion: 1,
    kind: "ci-finalized-recording",
    binding: binding(c, options.claim.sha256),
    report: {path: "recording/run.json", sha256: hash(reportBytes)},
    integrity: {path: "recording/integrity.json", sha256: hash(integrityBytes)},
    phaseByStep: phases,
  }
  return {
    passed: true,
    expected: "Finalized claim-bound recording and independent artifact verification",
    actual: descriptor as Json,
    observedAt: checkedAt,
    source: "registered CI recording integrity verifier",
    evidence: [descriptor.report.path, descriptor.integrity.path],
  }
}

function validateTerminal(events: LifecycleEvent[], state: LifecycleState, result: LifecycleResult, runID: string) {
  requireThat(
    events.length > 0 && events[0].type === "run-started" && events.at(-1)?.type === "run-finished",
    "Missing terminal lifecycle journal",
  )
  let at = -Infinity
  const intents = new Map<string, LifecycleEvent>(),
    dispatched = new Set<string>(),
    intentSteps = new Set<string>()
  for (const [i, event] of events.entries()) {
    requireThat(
      event.sequence === i + 1 &&
        PHASES.includes(event.phase) &&
        event.state?.schemaVersion === 1 &&
        event.state.runID === runID &&
        time(event.timestamp) >= at &&
        Number.isFinite(event.monotonicMs),
      "Invalid lifecycle journal order or identity",
    )
    at = time(event.timestamp)
    requireThat(i === events.length - 1 || event.type !== "run-finished", "Journal continued after terminal result")
    if (event.type === "mutation-intent") {
      const intent = event.details as Row
      requireThat(
        intent.operationID &&
          !intents.has(intent.operationID) &&
          intent.stepID === event.stepID &&
          intent.phase === event.phase &&
          event.state.activeOperationID === intent.operationID,
        "Invalid durable mutation intent",
      )
      requireThat(!intentSteps.has(intent.stepID), "More than one dispatch intent for the same step")
      intentSteps.add(intent.stepID)
      intents.set(intent.operationID, event)
    }
    if (event.type === "mutation-dispatched") {
      const intent = event.details as Row
      requireThat(
        intents.has(intent.operationID) && !dispatched.has(intent.operationID),
        "Dispatch lacks a unique prior durable intent",
      )
      const original = intents.get(intent.operationID)!.details as Row
      requireThat(
        intent.stepID === original.stepID &&
          intent.phase === original.phase &&
          intent.startedAt === original.startedAt &&
          event.stepID === original.stepID,
        "Dispatch identity differs from its durable intent",
      )
      dispatched.add(intent.operationID)
    }
  }
  equal(state, events.at(-1)!.state, "Checkpoint differs from terminal journal")
  requireThat(
    state.mode === "complete" &&
      state.testFrozen &&
      ["not-run", "passed", "failed", "cancelled"].includes(state.test) &&
      PHASES.every((p) => VERDICTS.includes(state.phases[p])) &&
      Array.isArray(state.operations),
    "Invalid completed lifecycle state",
  )
  equal(events.at(-1)!.details, result, "Result differs from terminal journal")
  equal(
    [...intents.keys()].sort(),
    state.operations.map((i) => i.operationID).sort(),
    "Final state lost a durable mutation intent",
  )
  for (const operation of state.operations) {
    requireThat(dispatched.has(operation.operationID), "Terminal lifecycle contains a partially written dispatch")
    const original = intents.get(operation.operationID)!.details as Row
    requireThat(
      operation.stepID === original.stepID &&
        operation.phase === original.phase &&
        operation.startedAt === original.startedAt,
      "Final operation differs from its durable intent",
    )
    const lastReconciliation = events.findLast((e) => e.type === "reconciliation" && e.stepID === operation.stepID)
    equal(
      operation.reconciliation,
      lastReconciliation?.details,
      "Final mutation reconciliation differs from its journal",
    )
  }
  const ready =
    state.phases.teardown === "passed" &&
    state.phases["return-verification"] === "passed" &&
    !state.activeOperationID &&
    !state.pendingReconciliation
  const outcome = !ready
    ? "failed"
    : state.test === "cancelled"
      ? "cancelled"
      : state.test === "not-run"
        ? "setup-failed"
        : state.test === "failed"
          ? "failed"
          : state.phases.evidence !== "passed"
            ? "incomplete"
            : "passed"
  equal(
    result,
    {
      schemaVersion: 1,
      runID,
      test: state.test,
      teardown: state.phases.teardown,
      returnVerification: state.phases["return-verification"],
      evidence: state.phases.evidence,
      fixture: ready ? "ready" : "recovery-required",
      outcome,
    },
    "Lifecycle outcome does not follow terminal phase results",
  )
  if (ready)
    requireThat(
      state.operations.every((i) => ["settled", "satisfied"].includes(i.reconciliation?.status ?? "unknown")),
      "Ready fixture has an unresolved mutation",
    )
  if (state.test === "passed") {
    requireThat(
      state.operations
        .filter((i) => ["setup", "test"].includes(i.phase))
        .every((i) => i.reconciliation?.status === "satisfied"),
      "Passed test has an unsatisfied setup/test mutation",
    )
    requireThat(
      state.testStarted &&
        ["preflight", "setup", "test", "final-assertions"].every(
          (p) => state.phases[p as keyof typeof state.phases] === "passed",
        ),
      "Passed test is missing its required phases",
    )
    for (const phase of ["preflight", "final-assertions"])
      requireThat(
        events.some((e) => e.phase === phase && e.type === "assertion" && (e.details as Row).passed === true),
        "Passed test lacks independent assertions",
      )
  }
  for (const phase of PHASES)
    if (state.phases[phase] === "passed") {
      requireThat(
        events.some(
          (e) =>
            e.phase === phase &&
            ((e.type === "phase-finished" && (e.details as Row).verdict === "passed") ||
              e.type === "teardown-not-needed"),
        ),
        "Passed phase has no journal completion",
      )
      requireThat(
        !events.some((e) => e.phase === phase && e.type === "assertion" && (e.details as Row).passed !== true),
        "Failed assertion was promoted to a passed phase",
      )
    }
  if (ready)
    requireThat(
      events.some(
        (e) => e.phase === "return-verification" && e.type === "assertion" && (e.details as Row).passed === true,
      ),
      "Ready fixture lacks independent return proof",
    )
}

/** Pure local publication preparation. Reads durable worker files; never consumes, retries, or changes a fixture. */
export async function exportCiRun(options: CiExportInputs & {outputDirectory: string}) {
  const c = await loadClaim(options),
    directory = c.row.runDirectory as string
  const originals: {path: string; sha256: string; limit: number}[] = [
    {...options.claim, limit: 4 * MAX_METADATA_BYTES},
    {...options.trust, limit: MAX_METADATA_BYTES},
  ]
  async function read(path: string, limit = 4 * MAX_METADATA_BYTES) {
    const bytes = await stableBytes(path, limit)
    originals.push({path, sha256: hash(bytes), limit})
    return bytes
  }
  const terminal = object(
    JSON.parse((await read(join(c.stateDirectory, "claims", `${c.request.requestId}.result.json`))).toString()),
    "Worker terminal result",
  ) as Row
  requireThat(
    terminal.schemaVersion === 1 &&
      terminal.status === "routine-finished" &&
      terminal.dispatchStarted === true &&
      terminal.requestId === c.request.requestId &&
      terminal.runID === c.row.runID &&
      terminal.runDirectory === directory,
    "Expected original completed CI lifecycle result, not interrupted or undispatched intake",
  )
  const descriptor = JSON.parse((await read(join(directory, "run.json"))).toString()) as Row
  equal(
    descriptor.routine,
    {id: c.request.routine.id, definitionDigest: c.registration.definitionDigest},
    "Lifecycle definition differs from registered claim",
  )
  equal(
    descriptor.selection,
    {
      runID: c.row.runID,
      fixtureID: c.registration.fixtureID,
      returnProfileDigest: c.registration.returnProfileDigest,
      inputs: {request: c.request, adapter: descriptor.selection?.inputs?.adapter},
    },
    "Lifecycle inputs differ from consumed request",
  )
  const state = JSON.parse((await read(join(directory, "state.json"))).toString()) as LifecycleState
  const lifecycle = JSON.parse((await read(join(directory, "result.json"))).toString()) as LifecycleResult
  const journal = await read(join(directory, "events.jsonl"), 32 * MAX_METADATA_BYTES)
  requireThat(journal.at(-1) === 10, "Partial lifecycle journal")
  const events = journal
    .toString()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as LifecycleEvent)
  validateTerminal(events, state, lifecycle, c.row.runID)
  equal(terminal.lifecycle, lifecycle, "Worker terminal result differs from lifecycle result")
  requireThat(
    time(events[0].timestamp) >= time(c.row.at) && time(terminal.at) >= time(events.at(-1)!.timestamp),
    "Worker/lifecycle time interval differs",
  )
  const evidenceEvents = events.filter(
    (e) =>
      e.phase === "evidence" && e.type === "assertion" && (e.details as Row).actual?.kind === "ci-finalized-recording",
  )
  requireThat(evidenceEvents.length <= 1, "Multiple finalized recording descriptors")
  let media: Awaited<ReturnType<typeof copyRecordedEvidence>> | undefined
  let recordedStatus: string | undefined
  let recordedProvenance: Record<string, string> = {}
  if (evidenceEvents.length) {
    const event = evidenceEvents[0],
      observation = event.details as Row,
      recording = observation.actual as Row
    requireThat(
      observation.passed === true &&
        recording.schemaVersion === 1 &&
        time(observation.observedAt) <= time(event.timestamp) + 1000,
      "Recording descriptor is not a passed evidence assertion",
    )
    equal(recording.binding, binding(c, options.claim.sha256), "Recording descriptor belongs to another claim")
    const reportPath = child(directory, recording.report.path),
      integrityPath = child(directory, recording.integrity.path)
    equal(
      observation.evidence,
      [recording.report.path, recording.integrity.path],
      "Descriptor evidence references differ",
    )
    requireThat(
      dirname(reportPath) !== directory &&
        basename(reportPath) === "run.json" &&
        dirname(integrityPath) === dirname(reportPath),
      "Recording must be contained within its claimed run directory",
    )
    const reportBytes = await read(reportPath),
      integrityBytes = await read(integrityPath)
    requireThat(
      hash(reportBytes) === recording.report.sha256 && hash(integrityBytes) === recording.integrity.sha256,
      "Recording descriptor hash mismatch",
    )
    const report = JSON.parse(reportBytes.toString()) as Row,
      integrity = JSON.parse(integrityBytes.toString()) as Row
    checkReport(report, c, options.claim.sha256)
    requireThat(
      time(observation.observedAt) >= time(report.ended) && time(observation.observedAt) === time(integrity.checkedAt),
      "Evidence observation predates the finalized recording",
    )
    equal(integrity.binding, recording.binding, "Integrity result belongs to another recording")
    requireThat(
      integrity.schemaVersion === 1 &&
        integrity.kind === "ci-recording-integrity" &&
        integrity.verifier?.harnessRevision === c.registration.harnessRevision &&
        integrity.verifier?.harnessHash === report.harnessHash &&
        HASH.test(integrity.verifier?.scriptSha256) &&
        integrity.checks?.artifactChecks === "passed" &&
        integrity.checks?.frameLiveness === "verified" &&
        integrity.checks?.status === report.status &&
        time(integrity.checkedAt) >= time(report.ended) &&
        time(integrity.checkedAt) <= time(event.timestamp) + 1000 &&
        time(report.ended) <= time(event.timestamp),
      "Invalid independently verified recording integrity result",
    )
    requireThat(Array.isArray(integrity.files) && integrity.files.length > 0, "Missing recording integrity inventory")
    const inventory = new Map<string, Row>()
    for (const file of integrity.files) {
      requireThat(
        !inventory.has(file.path) && HASH.test(file.sha256) && Number.isSafeInteger(file.size) && file.size > 0,
        "Invalid or duplicate integrity inventory entry",
      )
      const bytes = await read(child(dirname(reportPath), file.path), MAX_ASSET_BYTES)
      requireThat(
        bytes.length === file.size && hash(bytes) === file.sha256,
        "Frozen recording asset differs from its verified inventory",
      )
      inventory.set(file.path, file)
    }
    const requiredFiles = new Set([
      "run.json",
      "routine.mp4",
      "chapters.json",
      "index.html",
      ...report.results
        .filter((s: Row) => !["not-run", "not-applicable"].includes(s.status))
        .flatMap((s: Row) => [s.screenshot, s.accessibility]),
    ])
    equal(
      [...inventory.keys()].sort(),
      [...requiredFiles].sort(),
      "Verified inventory differs from required recorded evidence",
    )
    requireThat(
      inventory.get("run.json")!.sha256 === recording.report.sha256,
      "Integrity result refers to another report",
    )
    media = await copyRecordedEvidence(
      dirname(reportPath),
      options.outputDirectory,
      report,
      phaseMap(report, recording.phaseByStep),
    )
    equal(
      {duration: media.video.duration, width: media.video.width, height: media.video.height},
      {duration: integrity.checks.duration, width: integrity.checks.width, height: integrity.checks.height},
      "Probed recording differs from integrity result",
    )
    requireThat(
      integrity.checks.executed === media.chapters.filter((c) => c.videoAssetId).length,
      "Recorded execution count differs",
    )
    recordedStatus = report.status
    recordedProvenance = {
      recordingReportSha256: recording.report.sha256,
      recordingIntegritySha256: recording.integrity.sha256,
      harnessHash: report.harnessHash,
      driverHash: report.driverHash,
      recordingSourceReference: report.sourceReference,
    }
    if (lifecycle.test === "passed")
      requireThat(
        media.chapters.some((c) => c.phase === "test") &&
          media.chapters.filter((c) => ["test", "verify"].includes(c.phase)).every((c) => c.status === "passed"),
        "Passed lifecycle test contradicts recorded product steps",
      )
    if (lifecycle.outcome === "passed")
      requireThat(
        report.status === "passed" && media.chapters.every((c) => c.status === "passed"),
        "Passed lifecycle contradicts failed/incomplete recording",
      )
  }
  const output = resolve(options.outputDirectory)
  if (!media) {
    await noLinks(dirname(output))
    await mkdir(output, {mode: 0o700})
  }
  const assets: TestRunAsset[] = media?.assets ?? [],
    localAssets = media?.localAssets ?? []
  const complete = Boolean(media) && lifecycle.evidence === "passed"
  const verdict = (v: string) => (v === "passed" || v === "failed" || v === "not-run" ? v : "blocked")
  const outcomes = {
    test: verdict(lifecycle.test),
    teardown: verdict(lifecycle.teardown),
    fixture: lifecycle.fixture === "ready" ? "ready" : "unavailable",
    evidence: complete ? "complete" : "incomplete",
  }
  const outcome =
    lifecycle.outcome === "failed"
      ? "failed"
      : lifecycle.outcome === "cancelled"
        ? "aborted"
        : lifecycle.outcome === "passed" && complete
          ? "passed"
          : "blocked"
  const firmwareAssertions = projectFirmwareAssertions(events)
  const summary = {
    schemaVersion: 1,
    executionMode: "ci-registered",
    requestId: c.request.requestId,
    runID: c.row.runID,
    lifecycle,
    phases: state.phases,
    outcomes,
    recordedStatus: recordedStatus ?? null,
    journalSha256: hash(journal),
    terminalSequence: events.at(-1)!.sequence,
    firmwareAssertions,
    assertions: events
      .filter((e) => e.type === "assertion")
      .map((e) => ({
        sequence: e.sequence,
        phase: e.phase,
        stepID: e.stepID,
        passed: (e.details as Row).passed === true,
      })),
    mutations: state.operations.map((i) => ({
      operationID: i.operationID,
      stepID: i.stepID,
      phase: i.phase,
      reconciliation: i.reconciliation?.status ?? "unknown",
    })),
    scope:
      "Original consumed CI lifecycle. Raw claims, device logs, observation payloads and adapter errors are not published. Fixture is the terminal historical result, not a current readiness query.",
  }
  const bytes = json(summary),
    filename = "lifecycle-summary.json"
  await writeFile(join(output, filename), bytes, {flag: "wx", mode: 0o600})
  assets.push({
    assetId: "lifecycle-summary",
    kind: "metadata",
    contentType: "application/json",
    filename,
    sizeBytes: bytes.length,
    sha256: hash(bytes),
  })
  localAssets.push({assetId: "lifecycle-summary", path: filename})
  const selection = c.request.selection!
  const result = testRunSchema.parse({
    runId: c.row.runID,
    requestId: c.request.requestId,
    routineId: c.request.routine.id,
    routineVersion: `sha256:${c.registration.definitionDigest}`,
    platform: "ios-mac",
    channel: "pr",
    prNumber: c.request.pullRequest.number,
    startedAt: c.row.at,
    finishedAt: terminal.at,
    outcome,
    outcomes,
    provenance: {
      ...recordedProvenance,
      repository: c.request.trigger.repository,
      executionMode: "ci-registered",
      requestRelationship: "consumed",
      headSha: c.request.pullRequest.headSha,
      baseSha: c.request.pullRequest.baseSha,
      buildSha: selection.build.buildSha,
      mobileSourceCommit: String(selection.app.mobileSourceCommit ?? "unrecorded"),
      reusedCompilation: String(selection.app.reusedCompilation ?? "unrecorded"),
      claimSha256: options.claim.sha256,
      requestSha256: c.row.requestSha256,
      journalSha256: hash(journal),
      harnessSha: c.registration.harnessRevision,
      definitionDigest: c.registration.definitionDigest,
      qualificationDigest: c.registration.qualificationDigest,
      returnProfileDigest: c.registration.returnProfileDigest,
      requestSourceSha: c.request.trigger.sha,
      requestWorkflowSha: c.request.trigger.workflowSha,
      requestUrl: `https://github.com/${c.request.trigger.repository}/actions/runs/${c.request.trigger.runId}/attempts/${c.request.trigger.runAttempt}`,
      producerUrl: selection.producer.url,
      receiptSha256: selection.receipt.sha256,
      archiveSha256: selection.archive.sha256,
      manifestSha256: selection.otaManifest.sha256,
      lifecycleOutcome: lifecycle.outcome,
      returnVerification: lifecycle.returnVerification,
    },
    fixture: {alias: c.registration.fixtureID},
    firmwareAssertions,
    chapters: media?.chapters ?? [],
    assets,
    notes: complete
      ? "Recorded registered CI lifecycle; phase verdicts and fixture restoration are independent. Firmware comparisons retain their original lifecycle phase, including failed checks before successful cleanup."
      : "Terminal registered CI lifecycle without complete verified recorded evidence. Metadata-only export cannot qualify the routine as passed.",
  })
  requireThat(json(result).length <= MAX_METADATA_BYTES, "Export metadata exceeds 1 MiB")
  for (const source of originals)
    requireThat(
      hash(await stableBytes(source.path, source.limit)) === source.sha256,
      "CI source changed while exporting",
    )
  await media?.verifyUnchanged()
  for (const asset of assets)
    requireThat(
      hash(await stableBytes(join(output, asset.filename), MAX_ASSET_BYTES)) === asset.sha256,
      "Export asset changed before finalization",
    )
  await writeFile(join(output, "assets.json"), json({schemaVersion: 1, assets: localAssets}), {flag: "wx", mode: 0o600})
  await writeFile(join(output, "run.json"), json(result), {flag: "wx", mode: 0o600})
  return {runId: result.runId, outputDirectory: output, outcome: result.outcome, result}
}
