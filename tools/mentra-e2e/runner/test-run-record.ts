import {parseRoutineRequest, type RoutineRequest} from "./ci-request"

// Only transport-facing fields are checked here. The canonical full schema and
// semantic outcome checks belong to cloud-v2/packages/core/src/types/test-run.types.ts.
// No Cloud or Zod dependency is required to run this uploader.
export const MAX_METADATA_BYTES = 1024 * 1024
export const MAX_ASSET_BYTES = 128 * 1024 * 1024
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/
const HASH = /^[a-f0-9]{64}$/
const SHA = /^[a-f0-9]{40}$/
type Row = Record<string, unknown>
export interface TestRunAsset {
  assetId: string
  kind: "video" | "screenshot" | "log" | "metadata"
  contentType:
    | "video/mp4"
    | "video/webm"
    | "image/png"
    | "image/jpeg"
    | "image/webp"
    | "application/json"
    | "text/plain"
  filename: string
  sizeBytes: number
  sha256: string
}
export interface PublicationMetadata extends Record<string, unknown> {
  runId: string
  assets: TestRunAsset[]
  outcome: "passed" | "failed" | "blocked" | "aborted"
  outcomes: {evidence: "complete" | "incomplete"; [key: string]: unknown}
}

export function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
export function object(value: unknown, name: string, keys?: string[]): Row {
  requireThat(value && typeof value === "object" && !Array.isArray(value), `${name} must be an object`)
  const row = value as Row
  requireThat(!keys || Object.keys(row).every((key) => keys.includes(key)), `${name} contains unsupported fields`)
  return row
}
function text(value: unknown, name: string, max = 2000, min = 1): asserts value is string {
  requireThat(typeof value === "string" && value.length >= min && value.length <= max, `${name} is invalid`)
}
function id(value: unknown, name: string) {
  text(value, name, 120)
  requireThat(ID.test(value), `${name} is invalid`)
}
function oneOf(value: unknown, options: readonly string[], name: string) {
  requireThat(typeof value === "string" && options.includes(value), `${name} is invalid`)
}
function items(value: unknown, name: string, max: number): unknown[] {
  requireThat(Array.isArray(value) && value.length <= max, `${name} is invalid`)
  return value
}
function timestamp(value: unknown, name: string) {
  text(value, name)
  requireThat(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    `${name} is invalid`,
  )
  // Date.parse normalizes impossible calendar dates; do not accept them as evidence timestamps.
  const date = value.slice(0, 10)
  requireThat(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date, `${name} is invalid`)
}

/** Safe URL/file/upload preflight only. A successful POST is required for full server validation. */
export function parsePublicationMetadata(value: unknown): PublicationMetadata {
  const run = object(value, "Run")
  id(run.runId, "Run ID")
  oneOf(run.outcome, ["passed", "failed", "blocked", "aborted"], "Source outcome")
  const outcomes = object(run.outcomes, "Source outcomes")
  oneOf(outcomes.evidence, ["complete", "incomplete"], "Source evidence outcome")
  const assets = items(run.assets, "Assets", 2000)
  const byId = new Map<string, Row>()
  for (const value of assets) {
    const row = object(value, "Asset", ["assetId", "kind", "contentType", "filename", "sizeBytes", "sha256"])
    id(row.assetId, "Asset ID")
    oneOf(row.kind, ["video", "screenshot", "log", "metadata"], "Asset kind")
    oneOf(
      row.contentType,
      ["video/mp4", "video/webm", "image/png", "image/jpeg", "image/webp", "application/json", "text/plain"],
      "Asset content type",
    )
    const type = row.contentType as string
    requireThat(
      row.kind === "video"
        ? type.startsWith("video/")
        : row.kind === "screenshot"
          ? type.startsWith("image/")
          : ["application/json", "text/plain"].includes(type),
      "Asset kind/content type mismatch",
    )
    text(row.filename, "Asset filename", 200)
    requireThat(
      typeof row.sizeBytes === "number" &&
        Number.isSafeInteger(row.sizeBytes) &&
        row.sizeBytes >= 1 &&
        row.sizeBytes <= MAX_ASSET_BYTES,
      "Invalid asset size",
    )
    text(row.sha256, "Asset digest", 64)
    requireThat(HASH.test(row.sha256), "Invalid asset digest")
    requireThat(!byId.has(row.assetId as string), "Duplicate asset ID")
    byId.set(row.assetId as string, row)
  }
  return run as PublicationMetadata
}

/** Map an already verified request and its original durable intake result; this does not verify GitHub or dispatch hardware. */
export function mapCiIntakeResult(
  request: RoutineRequest,
  result: unknown,
  options: {startedAt: string; routineVersion: string; harnessSha: string},
) {
  request = parseRoutineRequest(Buffer.from(JSON.stringify(request)))
  const row = object(result, "Intake result", [
    "schemaVersion",
    "requestId",
    "status",
    "reason",
    "hardwareStarted",
    "at",
  ])
  requireThat(
    row.schemaVersion === 1 && row.requestId === request.requestId && row.hardwareStarted === false,
    "Intake result does not match request or started hardware",
  )
  requireThat(
    row.status === (request.status === "no-artifact" ? "no-artifact" : "blocked-unqualified"),
    "Expected original terminal intake result, not a replay status",
  )
  text(row.reason, "Intake reason", 4096)
  timestamp(row.at, "Intake result time")
  requireThat(SHA.test(options.harnessSha), "Actual harness SHA is required")
  timestamp(options.startedAt, "Intake start time")
  requireThat(Date.parse(row.at as string) >= Date.parse(options.startedAt), "Intake finish precedes start")
  text(options.routineVersion, "Routine version")
  return {
    runId: `${request.requestId}-intake`,
    requestId: request.requestId,
    routineId: request.routine.id,
    routineVersion: options.routineVersion,
    platform: "ios-mac",
    channel: "pr",
    prNumber: request.pullRequest.number,
    startedAt: options.startedAt,
    finishedAt: row.at,
    outcome: "blocked",
    outcomes: {test: "not-run", teardown: "not-run", fixture: "unknown", evidence: "complete"},
    provenance: {
      repository: request.trigger.repository,
      headSha: request.pullRequest.headSha,
      baseSha: request.pullRequest.baseSha,
      harnessSha: options.harnessSha,
      requestSourceSha: request.trigger.sha,
      requestWorkflowSha: request.trigger.workflowSha,
      requestCreatedAt: request.createdAt,
      requestUrl: `https://github.com/${request.trigger.repository}/actions/runs/${request.trigger.runId}/attempts/${request.trigger.runAttempt}`,
      intakeStatus: row.status,
      ...(request.selection
        ? {
            buildSha: request.selection.build.buildSha,
            manifestSha256: request.selection.otaManifest.sha256,
            producerUrl: request.selection.producer.url,
            receiptSha256: request.selection.receipt.sha256,
            archiveSha256: request.selection.archive.sha256,
          }
        : {}),
    },
    fixture: {alias: "unallocated"},
    firmwareAssertions: [],
    chapters: [],
    assets: [],
    notes: `${row.reason}\nNo device operation ran. This record describes CI intake only; no hardware qualification is claimed.`,
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`
  return JSON.stringify(value)
}
