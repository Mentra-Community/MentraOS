import {writeFile} from "node:fs/promises"
import {isAbsolute, join} from "node:path"
// Data-only canonical schema: no server, storage, authentication or publication code.
import {testRunSchema} from "../../../cloud-v2/packages/core/src/types/test-run.types"
import {verifyBuildManifest} from "./build-manifest"
import {parseRoutineRequest} from "./ci-request"
import {
  assertFirmwareState,
  parseFirmwareProfile,
  type FirmwareFixture,
  type FirmwareObservation,
} from "./firmware-profile"
import {copyRecordedEvidence, hash, noLinks, probe, stableBytes} from "./recorded-evidence"
import {canonicalJson, MAX_METADATA_BYTES, requireThat} from "./test-run-record"

type Row = Record<string, any>
type Reference = {path: string; sha256: string}
type Verdict = "passed" | "failed" | "blocked" | "not-run"
export interface Day1Assessment {
  schemaVersion: 1
  executionMode: "manual-supervised"
  sourceRunSha256: string
  fixtureAlias: string
  baseSha: string
  receipt: Reference & {url: string}
  manifest: Reference & {url: string}
  /** Context only: a supervised discovery does not consume an unattended CI request. */
  relatedRequest?: Reference
  outcomes: {test: Verdict; teardown: Verdict; fixture: "ready" | "unavailable" | "unknown"}
  /** Narrow component proof only; it cannot establish fixture readiness or a passing full test. */
  componentVerification?: Reference
  /** Required before accepting a passing test or a ready fixture. */
  finalState?: {profile: Reference; fixture: Reference; observation: Reference; verification: Reference}
  phaseByStep?: Record<string, "setup" | "test" | "verify" | "teardown">
  notes: string
}
export type {MediaProbe} from "./recorded-evidence"
export interface ExportDay1Options {
  runDirectory: string
  assessmentPath: string
  outputDirectory: string
}
const HASH = /^[a-f0-9]{64}$/
const SHA = /^[a-f0-9]{40}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/
function object(value: unknown, name: string): Row {
  requireThat(value && typeof value === "object" && !Array.isArray(value), `Invalid ${name}`)
  return value as Row
}
function text(value: unknown, name: string, max = 2000): string {
  requireThat(typeof value === "string" && value.length > 0 && value.length <= max, `Invalid ${name}`)
  return value
}
function date(value: unknown, name: string): number {
  const at = text(value, name)
  requireThat(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(at) && Number.isFinite(Date.parse(at)),
    `Invalid ${name}`,
  )
  return Date.parse(at)
}
function url(value: unknown): string {
  const parsed = new URL(text(value, "URL"))
  requireThat(
    parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash,
    "Expected public HTTPS provenance URL",
  )
  return parsed.href
}
async function reference(value: unknown) {
  const ref = object(value, "frozen reference")
  requireThat(
    isAbsolute(ref.path ?? "") && HASH.test(ref.sha256 ?? ""),
    "Frozen reference needs absolute path and SHA-256",
  )
  const bytes = await stableBytes(ref.path, 4 * MAX_METADATA_BYTES)
  requireThat(hash(bytes) === ref.sha256, "Frozen reference hash mismatch")
  return {bytes, value: object(JSON.parse(bytes.toString("utf8")), "referenced JSON")}
}
/** Local export only. The assessment is a reviewed claim; no hardware or CI authentication occurs here.
 * Media and frozen references are checked, and passing firmware claims are recomputed from the
 * existing verifier's bound inputs at its original observation time, never from a command exit. */
export async function exportDay1Run(options: ExportDay1Options, inspectVideo = probe) {
  const source = await noLinks(options.runDirectory)
  const runPath = join(source, "run.json")
  const runBytes = await stableBytes(runPath, 4 * MAX_METADATA_BYTES)
  const run = object(JSON.parse(runBytes.toString("utf8")), "source run")
  requireThat(
    ["passed", "failed", "incomplete", "observed"].includes(run.status) && run.ended,
    "Only finalized runs can be exported; active or interrupted records are not terminal evidence",
  )
  const started = date(run.started, "start time"),
    finished = date(run.ended, "finish time")
  requireThat(
    finished >= started &&
      run.executionMode === "interactive-discovery" &&
      Number.isSafeInteger(run.evidenceVersion) &&
      run.evidenceVersion >= 2 &&
      Array.isArray(run.results) &&
      run.results.length > 0,
    "Expected a finalized manual discovery run",
  )
  const assessmentBytes = await stableBytes(options.assessmentPath, MAX_METADATA_BYTES)
  const assessment = object(JSON.parse(assessmentBytes.toString("utf8")), "assessment") as Day1Assessment
  requireThat(
    assessment.schemaVersion === 1 &&
      assessment.executionMode === "manual-supervised" &&
      assessment.sourceRunSha256 === hash(runBytes),
    "Assessment must match the exact finalized manual source run",
  )
  text(assessment.fixtureAlias, "fixture alias")
  text(assessment.notes, "assessment notes", 16000)
  requireThat(
    SHA.test(assessment.baseSha ?? "") && HASH.test(run.harnessHash ?? "") && HASH.test(run.driverHash ?? ""),
    "Missing exact build/harness identities",
  )
  const outcomes = object(assessment.outcomes, "separate outcomes")
  requireThat(
    ["passed", "failed", "blocked", "not-run"].includes(outcomes.test) &&
      ["passed", "failed", "blocked", "not-run"].includes(outcomes.teardown) &&
      ["ready", "unavailable", "unknown"].includes(outcomes.fixture),
    "Invalid separate outcomes",
  )
  const {value: receipt} = await reference(assessment.receipt)
  const {bytes: manifestBytes} = await reference(assessment.manifest)
  const app = object(run.verifiedCiBuild, "verified CI app")
  verifyBuildManifest(app, {
    ...run.app,
    executableSha256: run.appExecutableHash,
    javascriptSha256: run.appJavascriptHash,
  })
  requireThat(
    canonicalJson(receipt.app) === canonicalJson(app) &&
      receipt.pr === app.pr &&
      receipt.headSha === app.headSha &&
      receipt.buildSha === app.buildSha &&
      receipt.runId === app.runId &&
      receipt.runAttempt === app.runAttempt,
    "Receipt does not describe the recorded app",
  )
  requireThat(HASH.test(receipt.artifacts?.mac?.sha256 ?? ""), "Receipt has no exact Mac archive digest")
  requireThat(url(assessment.manifest.url) === app.otaManifestUrl, "Export manifest differs from the recorded app pin")
  const selected = parseFirmwareProfile(manifestBytes, {
    url: assessment.manifest.url,
    sha256: assessment.manifest.sha256,
    size: manifestBytes.length,
  })
  const phases = assessment.phaseByStep ?? {}
  requireThat(
    Object.entries(phases).every(
      ([id, phase]) =>
        run.results.some((step: Row) => step.id === id) && ["setup", "test", "verify", "teardown"].includes(phase),
    ),
    "Phase map includes an unknown source step",
  )
  const productSteps = run.results.filter((step: Row) => ["test", "verify"].includes(phases[step.id] ?? "test"))
  const failedSteps = run.results.some((step: Row) => step.status === "failed")
  const unclassifiedFailure = run.status === "failed" && !failedSteps
  requireThat(
    !(productSteps.some((step: Row) => step.status === "failed") || unclassifiedFailure) || outcomes.test === "failed",
    "Failed source observations cannot be promoted or hidden",
  )
  requireThat(
    !run.results.some((step: Row) => phases[step.id] === "teardown" && step.status === "failed") ||
      outcomes.teardown === "failed",
    "Failed teardown observations cannot be promoted or hidden",
  )
  requireThat(
    outcomes.test !== "passed" ||
      (run.status !== "incomplete" &&
        !unclassifiedFailure &&
        productSteps.length > 0 &&
        productSteps.every((step: Row) => step.status === "passed")),
    "A passing test needs every recorded required step to pass",
  )
  requireThat(
    outcomes.fixture !== "ready" || outcomes.teardown === "passed",
    "Ready fixture requires a passed teardown",
  )
  let firmwareAssertions: Row[] = [
    {
      component: "Target MTK",
      expected: selected.mtk.version,
      actual: "Not independently verified in this export",
      status: "not-run",
    },
    {
      component: "Target BES",
      expected: selected.bes.version,
      actual: "Not independently verified in this export",
      status: "not-run",
    },
    {
      component: "Target ASG",
      expected: `${selected.asg.versionCode} / SHA-256 ${selected.asg.artifact.sha256}`,
      actual: "Not independently verified in this export",
      status: "not-run",
    },
  ]
  let finalVerification: Row | undefined
  let componentVerification: Row | undefined
  if (assessment.componentVerification) {
    const {value: observed} = await reference(assessment.componentVerification)
    const at = date(observed.verifiedAt, "component verification time")
    requireThat(
      at >= started &&
        at <= finished &&
        observed.manifestSha256 === selected.manifest.sha256 &&
        observed.fullFixtureReturnQualified === false,
      "Component proof must match this run and manifest without claiming fixture qualification",
    )
    const state = object(observed.state, "component state"),
      bes = object(observed.bes, "component BES response")
    requireThat(
      typeof state.serial === "string" &&
        state.serial.length > 0 &&
        /^[a-f0-9]{32}$/i.test(state.cid ?? "") &&
        /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(state.bluetooth ?? "") &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(state.bootId ?? "") &&
        state.bootCompleted === "1" &&
        Number.isSafeInteger(state.asgVersion) &&
        state.asgVersion > 0 &&
        HASH.test(observed.apkSha256 ?? "") &&
        Number.isFinite(bes.ageSeconds) &&
        bes.ageSeconds >= 0 &&
        bes.ageSeconds <= 30,
      "Component proof lacks fresh, identified firmware observations",
    )
    const comparisons = [
      {component: "Target MTK", expected: selected.mtk.version, actual: text(state.firmware, "observed MTK")},
      {component: "Target BES", expected: selected.bes.version, actual: text(bes.version, "observed BES")},
      {component: "Target ASG version", expected: String(selected.asg.versionCode), actual: String(state.asgVersion)},
      {component: "Target active ASG APK SHA-256", expected: selected.asg.artifact.sha256, actual: observed.apkSha256},
    ].map((row) => ({...row, status: row.expected === row.actual ? "passed" : "failed"}))
    requireThat(
      observed.componentVersionsMatch === comparisons.every((row) => row.status === "passed"),
      "Component proof verdict contradicts its observed values",
    )
    firmwareAssertions = comparisons
    componentVerification = {
      sourceSha256: assessment.componentVerification.sha256,
      verifiedAt: observed.verifiedAt,
      manifestSha256: observed.manifestSha256,
      identity: {serial: state.serial, cid: state.cid, bluetooth: state.bluetooth, bootId: state.bootId},
      besObservationAgeSeconds: bes.ageSeconds,
      assertions: comparisons,
      fullFixtureReturnQualified: false,
      scope: "Component versions and active APK only. Updater idle and full fixture return remain unqualified.",
    }
  }
  if (assessment.finalState) {
    const [profile, physical, observed, checked] = await Promise.all([
      reference(assessment.finalState.profile),
      reference(assessment.finalState.fixture),
      reference(assessment.finalState.observation),
      reference(assessment.finalState.verification),
    ])
    const at = date(checked.value.checkedAt, "firmware verification time")
    requireThat(at >= started && at <= finished, "Final firmware verification belongs outside the recorded run")
    requireThat(
      canonicalJson(profile.value) === canonicalJson(selected),
      "Firmware profile differs from selected manifest",
    )
    requireThat(
      checked.value.mode === "offline-assertion" &&
        checked.value.inputs?.profileSha256 === hash(profile.bytes) &&
        checked.value.inputs?.fixtureSha256 === hash(physical.bytes) &&
        checked.value.inputs?.observationSha256 === hash(observed.bytes),
      "Final firmware result is not bound to its inputs",
    )
    const assertions = assertFirmwareState(
      selected,
      physical.value as FirmwareFixture,
      observed.value as Partial<FirmwareObservation>,
      at,
    )
    requireThat(
      canonicalJson(assertions) === canonicalJson(checked.value.assertions) &&
        checked.value.status === (assertions.every((entry) => entry.status === "passed") ? "passed" : "failed"),
      "Firmware result contradicts recomputed assertions",
    )
    firmwareAssertions = assertions.map((entry) => ({
      component: entry.id,
      expected: text(JSON.stringify(entry.expected), "expected firmware assertion"),
      actual: text(JSON.stringify(entry.actual), "actual firmware assertion"),
      status: entry.status,
    }))
    finalVerification = {
      mode: "offline-assertion",
      checkedAt: checked.value.checkedAt,
      inputs: {
        profileSha256: hash(profile.bytes),
        fixtureSha256: hash(physical.bytes),
        observationSha256: hash(observed.bytes),
      },
      status: checked.value.status,
      assertions: firmwareAssertions,
    }
  }
  requireThat(
    (outcomes.test !== "passed" && outcomes.fixture !== "ready") || finalVerification?.status === "passed",
    "Passing test or ready fixture needs all bound final firmware assertions",
  )
  const provenance: Record<string, string> = {
    repository: "Mentra-Community/MentraOS",
    executionMode: "manual-supervised",
    origin: "Supervised customer qualification; no unattended CI request was consumed",
    headSha: app.headSha,
    baseSha: assessment.baseSha,
    buildSha: app.buildSha,
    mobileSourceCommit: app.mobileSourceCommit,
    reusedCompilation: String(app.reusedCompilation),
    harnessSha256: run.harnessHash,
    driverSha256: run.driverHash,
    producerUrl: `https://github.com/Mentra-Community/MentraOS/actions/runs/${app.runId}/attempts/${app.runAttempt}`,
    receiptUrl: url(assessment.receipt.url),
    receiptSha256: assessment.receipt.sha256,
    archiveSha256: receipt.artifacts.mac.sha256,
    manifestUrl: app.otaManifestUrl,
    manifestSha256: assessment.manifest.sha256,
    appVersion: app.version,
    appBuild: app.build,
    appExecutableSha256: app.executableSha256,
    appJavascriptSha256: app.javascriptSha256,
    sourceRunSha256: hash(runBytes),
    assessmentSha256: hash(assessmentBytes),
  }
  if (assessment.relatedRequest) {
    const requestFile = await reference(assessment.relatedRequest)
    const request = parseRoutineRequest(requestFile.bytes)
    requireThat(
      request.pullRequest.number === app.pr &&
        request.pullRequest.headSha === app.headSha &&
        request.pullRequest.baseSha === assessment.baseSha &&
        request.routine.id === "day1-ota",
      "Related CI request targets another candidate",
    )
    requireThat(
      !request.selection ||
        (request.selection.build.buildSha === app.buildSha &&
          request.selection.receipt.sha256 === assessment.receipt.sha256 &&
          request.selection.receipt.url === assessment.receipt.url &&
          request.selection.otaManifest.sha256 === assessment.manifest.sha256 &&
          request.selection.archive.sha256 === receipt.artifacts.mac.sha256),
      "Related CI selection differs from the tested artifact",
    )
    Object.assign(provenance, {
      relatedRequestId: request.requestId,
      relatedRequestSha256: assessment.relatedRequest.sha256,
      relatedRequestStatus: request.status,
      relatedRequestRelationship: "context-only-not-consumed",
      relatedRequestSourceSha: request.trigger.sha,
      relatedRequestWorkflowSha: request.trigger.workflowSha,
      relatedRequestUrl: `https://github.com/${request.trigger.repository}/actions/runs/${request.trigger.runId}/attempts/${request.trigger.runAttempt}`,
    })
  }
  const {output, assets, localAssets, chapters, video, add, verifyUnchanged} = await copyRecordedEvidence(
    source,
    options.outputDirectory,
    run,
    phases,
    inspectVideo,
  )
  const outcome =
    outcomes.test === "failed" || outcomes.teardown === "failed"
      ? "failed"
      : outcomes.test === "passed" &&
          outcomes.teardown === "passed" &&
          outcomes.fixture === "ready" &&
          chapters.every((entry) => entry.status === "passed")
        ? "passed"
        : "blocked"
  const summary = {
    schemaVersion: 1,
    executionMode: "manual-supervised",
    sourceStatus: run.status,
    sourceRunSha256: hash(runBytes),
    outcomes: {...outcomes, evidence: "complete"},
    media: video,
    sourceStepCount: run.results.length,
    sourceStepVerdicts: run.results.map((step: Row) => ({id: step.id, status: step.status})),
    finalFirmwareResult: finalVerification ?? null,
    componentVerification: componentVerification ?? null,
    scope:
      "Actual finalized customer recording; assessment supplies separate test and restoration claims. Export does not authenticate hardware observations or establish setup qualification.",
  }
  await add(
    "observations",
    "metadata",
    "application/json",
    "observations.json",
    Buffer.from(JSON.stringify(summary, null, 2) + "\n"),
  )
  const result = {
    runId: `manual-day1-${hash(runBytes).slice(0, 24)}`,
    requestId: `manual-${app.headSha.slice(0, 12)}-${hash(runBytes).slice(0, 16)}`,
    routineId: "day1-ota",
    routineVersion: `manual-discovery-harness-sha256:${run.harnessHash}`,
    platform: "ios-mac",
    channel: "pr",
    prNumber: app.pr,
    startedAt: run.started,
    finishedAt: run.ended,
    outcome,
    outcomes: {...outcomes, evidence: "complete"},
    provenance,
    fixture: {alias: assessment.fixtureAlias},
    firmwareAssertions,
    chapters,
    assets,
    notes: `${assessment.notes}\nManual supervised execution; no unattended CI request was consumed. Evidence complete describes these declared recording assets, not completion of setup or restoration.`,
  }
  const validated = testRunSchema.parse(result)
  requireThat(Buffer.byteLength(JSON.stringify(result)) <= MAX_METADATA_BYTES, "Export metadata exceeds 1 MiB")
  // Publishable files appear last. An interrupted export cannot look like a complete run.
  requireThat(
    hash(await stableBytes(runPath, 4 * MAX_METADATA_BYTES)) === hash(runBytes) &&
      hash(await stableBytes(options.assessmentPath, MAX_METADATA_BYTES)) === hash(assessmentBytes),
    "Finalized source changed while exporting",
  )
  await verifyUnchanged()
  await writeFile(
    join(output, "assets.json"),
    JSON.stringify({schemaVersion: 1, assets: localAssets}, null, 2) + "\n",
    {flag: "wx", mode: 0o600},
  )
  await writeFile(join(output, "run.json"), JSON.stringify(result, null, 2) + "\n", {flag: "wx", mode: 0o600})
  return {runId: result.runId, outputDirectory: output, outcome, result: validated}
}
