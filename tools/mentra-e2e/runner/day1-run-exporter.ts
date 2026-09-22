import {createHash} from "node:crypto"
import {constants} from "node:fs"
import {lstat, mkdir, open, writeFile} from "node:fs/promises"
import {dirname, isAbsolute, join, parse, resolve, sep} from "node:path"
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
import {
  canonicalJson,
  MAX_ASSET_BYTES,
  MAX_METADATA_BYTES,
  requireThat,
  type TestRunAsset,
} from "./test-run-record"

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
export interface MediaProbe {
  duration: number
  width: number
  height: number
}
export interface ExportDay1Options {
  runDirectory: string
  assessmentPath: string
  outputDirectory: string
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
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
async function noLinks(path: string) {
  const full = resolve(path)
  let current = parse(full).root
  for (const part of full.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    requireThat(!(await lstat(current)).isSymbolicLink(), "Export input/output paths must not traverse symlinks")
  }
  return full
}
async function stableBytes(path: string, limit: number) {
  await noLinks(path)
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await fd.stat()
    requireThat(
      before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= limit,
      "Export input must be a regular private file within its size limit",
    )
    const buffer = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < buffer.length) {
      const {bytesRead} = await fd.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    const bytes = buffer.subarray(0, length)
    const after = await fd.stat()
    requireThat(
      bytes.length === before.size &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs,
      "Source changed during export",
    )
    return bytes
  } finally {
    await fd.close()
  }
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
function child(root: string, path: unknown) {
  const name = text(path, "relative source asset", 4096)
  requireThat(
    !isAbsolute(name) &&
      !name.includes("\\") &&
      !/[\x00-\x1f\x7f]/.test(name) &&
      name.split("/").every((part) => part && part !== "." && part !== ".."),
    "Asset path escapes the source run",
  )
  return join(root, name)
}
async function probe(path: string): Promise<MediaProbe> {
  const process = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,nb_frames,duration",
      "-of",
      "json",
      path,
    ],
    {stdout: "pipe", stderr: "pipe"},
  )
  const timer = setTimeout(() => process.kill(), 15000)
  try {
    const [output, code] = await Promise.all([new Response(process.stdout).text(), process.exited])
    requireThat(code === 0, "ffprobe could not verify the finalized recording")
    const stream = JSON.parse(output).streams?.[0]
    requireThat(
      stream?.codec_name === "h264" &&
        Number(stream.nb_frames) > 0 &&
        Number(stream.duration) > 0 &&
        Number.isSafeInteger(stream.width) &&
        stream.width > 0 &&
        Number.isSafeInteger(stream.height) &&
        stream.height > 0,
      "Recording is not a nonempty H264 video",
    )
    return {duration: Number(stream.duration), width: stream.width, height: stream.height}
  } finally {
    clearTimeout(timer)
  }
}
async function decodeScreenshot(path: string) {
  const process = Bun.spawn(
    ["ffmpeg", "-v", "error", "-xerror", "-i", path, "-frames:v", "1", "-f", "null", "-"],
    {stdout: "ignore", stderr: "ignore"},
  )
  const timer = setTimeout(() => process.kill(), 15000)
  try {
    requireThat(await process.exited === 0, "Screenshot cannot be decoded completely")
  } finally {
    clearTimeout(timer)
  }
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
      Number.isSafeInteger(run.evidenceVersion) && run.evidenceVersion >= 2 &&
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
    Object.entries(phases).every(([id, phase]) =>
      run.results.some((step: Row) => step.id === id) && ["setup", "test", "verify", "teardown"].includes(phase)),
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
      (run.status !== "incomplete" && !unclassifiedFailure && productSteps.length > 0 &&
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
      at >= started && at <= finished && observed.manifestSha256 === selected.manifest.sha256 &&
        observed.fullFixtureReturnQualified === false,
      "Component proof must match this run and manifest without claiming fixture qualification",
    )
    const state = object(observed.state, "component state"), bes = object(observed.bes, "component BES response")
    requireThat(
      typeof state.serial === "string" && state.serial.length > 0 &&
        /^[a-f0-9]{32}$/i.test(state.cid ?? "") &&
        /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(state.bluetooth ?? "") &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(state.bootId ?? "") &&
        state.bootCompleted === "1" && Number.isSafeInteger(state.asgVersion) && state.asgVersion > 0 &&
        HASH.test(observed.apkSha256 ?? "") && Number.isFinite(bes.ageSeconds) &&
        bes.ageSeconds >= 0 && bes.ageSeconds <= 30,
      "Component proof lacks fresh, identified firmware observations",
    )
    const comparisons = [
      {component: "Target MTK", expected: selected.mtk.version, actual: text(state.firmware, "observed MTK")},
      {component: "Target BES", expected: selected.bes.version, actual: text(bes.version, "observed BES")},
      {component: "Target ASG version", expected: String(selected.asg.versionCode), actual: String(state.asgVersion)},
      {component: "Target active ASG APK SHA-256", expected: selected.asg.artifact.sha256, actual: observed.apkSha256},
    ].map(row => ({...row, status: row.expected === row.actual ? "passed" : "failed"}))
    requireThat(
      observed.componentVersionsMatch === comparisons.every(row => row.status === "passed"),
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
  const videoPath = join(source, "routine.mp4")
  requireThat(run.video?.event === "finished", "Recording was not finalized")
  const sourceChaptersBytes = await stableBytes(join(source, "chapters.json"), MAX_METADATA_BYTES)
  const sourceChapters = JSON.parse(sourceChaptersBytes.toString("utf8"))
  requireThat(Array.isArray(sourceChapters), "Missing source chapters")
  const assets: TestRunAsset[] = [],
    localAssets: {assetId: string; path: string}[] = [],
    originals: {path: string; digest: string}[] = []
  const output = resolve(options.outputDirectory)
  await noLinks(dirname(output))
  await mkdir(output, {mode: 0o700})
  async function add(
    assetId: string,
    kind: TestRunAsset["kind"],
    contentType: TestRunAsset["contentType"],
    filename: string,
    bytes: Buffer,
  ) {
    requireThat(bytes.length > 0 && bytes.length <= MAX_ASSET_BYTES, "Evidence exceeds the admin asset size limit")
    const sha256 = hash(bytes)
    await writeFile(join(output, filename), bytes, {flag: "wx", mode: 0o600})
    assets.push({assetId, kind, contentType, filename, sizeBytes: bytes.length, sha256})
    localAssets.push({assetId, path: filename})
  }
  async function copy(
    assetId: string,
    kind: TestRunAsset["kind"],
    contentType: TestRunAsset["contentType"],
    filename: string,
    path: string,
  ) {
    const bytes = await stableBytes(path, MAX_ASSET_BYTES)
    originals.push({path, digest: hash(bytes)})
    await add(assetId, kind, contentType, filename, bytes)
    return bytes
  }
  const videoBytes = await copy("recording", "video", "video/mp4", "routine.mp4", videoPath)
  requireThat(videoBytes.subarray(4, 8).toString() === "ftyp", "Recording is not MP4")
  // Probe the same frozen bytes that are published, never a replaceable source pathname.
  const video = await inspectVideo(join(output, "routine.mp4"))
  requireThat(
    Number.isFinite(video.duration) && video.duration > 0 &&
      Math.abs(video.duration - run.video.duration) < 0.1,
    "Finalized recording duration changed",
  )
  const chapters: Row[] = []
  const ids = new Set<string>()
  let previous = -1
  for (const [index, value] of run.results.entries()) {
    const step = object(value, "source step")
    requireThat(ID.test(step.id ?? "") && !ids.has(step.id), "Duplicate or malformed step ID")
    ids.add(step.id)
    requireThat(["passed", "failed", "not-run", "not-applicable"].includes(step.status), "Unknown source step verdict")
    const phase = phases[step.id] ?? "test"
    requireThat(["setup", "test", "verify", "teardown"].includes(phase), "Invalid chapter phase")
    const chapter: Row = {
      id: step.id,
      instruction: text(step.instruction, "step instruction"),
      expected: text(step.expected, "step expectation"),
      status: step.status === "not-applicable" ? "not-run" : step.status,
      phase,
    }
    if (!["not-run", "not-applicable"].includes(step.status)) {
      const original = sourceChapters.filter((entry: Row) => entry.id === step.id)
      requireThat(
        original.length === 1 &&
          original[0].start === step.videoStart &&
          original[0].end === step.videoEnd &&
          original[0].description === step.instruction &&
          original[0].expected === step.expected &&
          original[0].status === step.status,
        "Chapter does not match source result",
      )
      requireThat(
        Number.isFinite(step.videoStart) &&
          step.videoStart >= 0 &&
          step.videoStart >= previous &&
          Number.isFinite(step.videoEnd) &&
          step.videoEnd >= step.videoStart &&
          step.videoEnd <= video.duration + 0.1,
        "Chapter is outside the finalized video",
      )
      requireThat(
        Number.isFinite(step.screenshotVideoTime) &&
          step.screenshotVideoTime >= 0 && step.screenshotVideoTime <= video.duration + 0.1 &&
          Number.isFinite(step.screenshotObservationAgeSeconds) &&
          step.screenshotObservationAgeSeconds >= 0 && step.screenshotObservationAgeSeconds <= 1 &&
          Number.isFinite(step.screenshotObservedVideoTime) &&
          step.screenshotObservedVideoTime >= Math.max(0, step.videoEnd - 1) &&
          step.screenshotObservedVideoTime <= video.duration + 0.1,
        "Screenshot is stale or outside the recorded evidence interval",
      )
      previous = step.videoStart
      const screenshotId = `screenshot-${String(index + 1).padStart(3, "0")}`
      const png = await copy(
        screenshotId,
        "screenshot",
        "image/png",
        `${screenshotId}.png`,
        child(source, step.screenshot),
      )
      requireThat(
        png.length >= 24 &&
          png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" &&
          png.readUInt32BE(16) === video.width &&
          png.readUInt32BE(20) === video.height,
        "Screenshot dimensions/format differ from recorded video",
      )
      await decodeScreenshot(join(output, `${screenshotId}.png`))
      Object.assign(chapter, {
        videoAssetId: "recording",
        videoStart: step.videoStart,
        videoEnd: step.videoEnd,
        screenshotAssetId: screenshotId,
      })
    }
    chapters.push(chapter)
  }
  requireThat(
    sourceChapters.length === chapters.filter((entry) => entry.videoAssetId).length,
    "Unexpected source chapters",
  )
  await add(
    "chapters",
    "metadata",
    "application/json",
    "chapters.json",
    Buffer.from(JSON.stringify(chapters, null, 2) + "\n"),
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
      hash(await stableBytes(options.assessmentPath, MAX_METADATA_BYTES)) === hash(assessmentBytes) &&
      hash(await stableBytes(join(source, "chapters.json"), MAX_METADATA_BYTES)) === hash(sourceChaptersBytes),
    "Finalized source changed while exporting",
  )
  for (const original of originals)
    requireThat(
      hash(await stableBytes(original.path, MAX_ASSET_BYTES)) === original.digest,
      "Source asset changed while exporting",
    )
  for (const asset of assets)
    requireThat(
      hash(await stableBytes(join(output, asset.filename), MAX_ASSET_BYTES)) === asset.sha256,
      "Frozen output asset changed while exporting",
    )
  await writeFile(
    join(output, "assets.json"),
    JSON.stringify({schemaVersion: 1, assets: localAssets}, null, 2) + "\n",
    {flag: "wx", mode: 0o600},
  )
  await writeFile(join(output, "run.json"), JSON.stringify(result, null, 2) + "\n", {flag: "wx", mode: 0o600})
  return {runId: result.runId, outputDirectory: output, outcome, result: validated}
}
