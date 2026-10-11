/**
 * @fileoverview Bluetooth SDK startup update check.
 *
 * Every Mentra Bluetooth SDK start (Android, iOS, React Native) asks Core
 * whether a newer SDK release exists on its release channel. This module holds
 * the logic behind `POST /api/client/bluetooth-sdk/update-check`:
 *
 *   - request validation (`parseUpdateCheckRequest`)
 *   - version parsing, channel mapping and comparison (`parseSdkVersion`,
 *     `compareSdkVersions`, `decideUpdateStatus`)
 *   - the npm dist-tag cache for `@mentra/bluetooth-sdk`
 *     (`BluetoothSdkUpdateService.distTags`)
 *   - the PostHog record of each check (`BluetoothSdkUpdateService.record`),
 *     which is how Mentra counts active installs per customer app. It uses
 *     Core's `POSTHOG_API_KEY`: in production that is the Bluetooth SDK's own
 *     PostHog project, so these checks land beside the SDK's usage events;
 *     dev and staging write to the development project.
 *
 * Spec: notes/superpowers/specs/2026-10-11-bluetooth-sdk-live-telemetry-and-update-check.md
 *       ("Startup update check")
 */

import {randomUUID} from "node:crypto"
import {createLogger} from "@mentra/cloud-shared"
import {z} from "zod"

const logger = createLogger("core").child({service: "bluetooth-sdk-update"})

export const BLUETOOTH_SDK_DIST_TAGS_URL = "https://registry.npmjs.org/-/package/@mentra/bluetooth-sdk/dist-tags"
export const BLUETOOTH_SDK_POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/i/v0/e/"
export const BLUETOOTH_SDK_UPDATE_CHECK_EVENT = "bluetooth_sdk_update_check"
export const BLUETOOTH_SDK_MIN_SUPPORTED_VERSION_ENV = "BLUETOOTH_SDK_MIN_SUPPORTED_VERSION"

export const DIST_TAG_CACHE_TTL_MS = 10 * 60_000
/** After a failed refresh, wait this long before trying npm again. */
export const DIST_TAG_RETRY_AFTER_FAILURE_MS = 60_000
export const DIST_TAG_FETCH_TIMEOUT_MS = 3_000
export const CAPTURE_TIMEOUT_MS = 4_000
const MAX_FIELD_LENGTH = 128

export type SdkChannel = "latest" | "beta" | "dev"
export type UpdateStatus = "current" | "update_available" | "unsupported" | "unknown"

/** The flat response body. SDK clients parse it directly. */
export interface UpdateCheckResult {
  status: UpdateStatus
  channel: SdkChannel
  latestVersion: string | null
  minimumSupportedVersion: string | null
}

// ─── Request validation ─────────────────────────────────────────────────────

/** Treats null, undefined and whitespace-only strings as absent. */
function blankToUndefined(value: unknown): unknown {
  if (value === null || value === undefined) return undefined
  if (typeof value === "string" && value.trim() === "") return undefined
  return value
}

const requiredText = z.string().trim().min(1).max(MAX_FIELD_LENGTH)
const optionalText = z.preprocess(blankToUndefined, requiredText.optional())
const trimmedEnum = <T extends z.ZodTypeAny>(values: T) => z.string().trim().pipe(values)
const optionalEnum = <T extends z.ZodTypeAny>(values: T) =>
  z.preprocess(blankToUndefined, trimmedEnum(values).optional())
const optionalOsVersion = z.preprocess(
  (value) => (typeof value === "number" && Number.isFinite(value) ? String(value) : blankToUndefined(value)),
  requiredText.optional(),
)

const updateCheckRequestSchema = z.object({
  install_id: requiredText,
  app_identifier: requiredText,
  sdk_version: requiredText,
  sdk_platform: trimmedEnum(z.enum(["android", "ios"])),
  sdk_surface: optionalEnum(z.enum(["react_native", "android", "ios"])),
  app_version: optionalText,
  app_build: optionalText,
  app_build_type: optionalEnum(z.enum(["debug", "release"])),
  app_install_source: optionalText,
  app_environment: optionalText,
  os_platform: optionalText,
  os_version: optionalOsVersion,
})

export type UpdateCheckRequest = z.infer<typeof updateCheckRequestSchema>

/**
 * Validates a parsed JSON body. Strings are trimmed and capped at 128
 * characters; unknown fields are dropped. Returns null when the body is not a
 * valid update check.
 */
export function parseUpdateCheckRequest(body: unknown): UpdateCheckRequest | null {
  const parsed = updateCheckRequestSchema.safeParse(body)
  return parsed.success ? parsed.data : null
}

// ─── Versions ───────────────────────────────────────────────────────────────

export interface SdkVersion {
  major: number
  minor: number
  patch: number
  channel: SdkChannel
  /** N of a `-dev.N` / `-beta.N` prerelease; null for a plain release. */
  prerelease: number | null
}

const SDK_VERSION_PATTERN = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-(dev|beta)\.(\d{1,9}))?$/
const PLAIN_VERSION_PATTERN = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/

/**
 * Parses `X.Y.Z`, `X.Y.Z-dev.N` or `X.Y.Z-beta.N`. Any other form, including
 * other prerelease labels such as `-rc.1`, returns null.
 */
export function parseSdkVersion(raw: string | null | undefined): SdkVersion | null {
  const match = raw?.trim().match(SDK_VERSION_PATTERN)
  if (!match) return null
  const label = match[4] as "dev" | "beta" | undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    channel: label ?? "latest",
    prerelease: match[5] === undefined ? null : Number(match[5]),
  }
}

/** Parses a plain `X.Y.Z` (the minimum supported version). */
export function parsePlainVersion(raw: string | null | undefined): SdkVersion | null {
  const value = raw?.trim()
  if (!value || !PLAIN_VERSION_PATTERN.test(value)) return null
  return parseSdkVersion(value)
}

/** Compares `X.Y.Z` only, ignoring any prerelease part. */
export function compareBaseVersions(a: SdkVersion, b: SdkVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/**
 * Orders two versions on the same channel. The base `X.Y.Z` decides first.
 * At an equal base, two prereleases compare by N, and a plain release ranks
 * above a prerelease of the same base (semver).
 */
export function compareSdkVersions(a: SdkVersion, b: SdkVersion): number {
  const base = compareBaseVersions(a, b)
  if (base !== 0) return base
  if (a.prerelease === null && b.prerelease === null) return 0
  if (a.prerelease === null) return 1
  if (b.prerelease === null) return -1
  return a.prerelease - b.prerelease
}

/**
 * Decides the response for one SDK version.
 *
 * `unsupported` needs only the minimum, so it is reported even when npm has
 * never answered. Otherwise the SDK is compared with its channel's dist-tag:
 * lower is `update_available`; equal or higher (e.g. an unreleased local
 * build) is `current`. A missing or unparseable tag is `unknown`.
 */
export function decideUpdateStatus(input: {
  sdkVersion: string
  distTags: Readonly<Record<string, string>> | null
  minimumSupportedVersion: string | null | undefined
}): UpdateCheckResult {
  const minimum = parsePlainVersion(input.minimumSupportedVersion)
  const minimumSupportedVersion = minimum ? input.minimumSupportedVersion!.trim() : null
  const sdk = parseSdkVersion(input.sdkVersion)
  if (!sdk) return {status: "unknown", channel: "latest", latestVersion: null, minimumSupportedVersion}

  const rawTag = input.distTags?.[sdk.channel]?.trim()
  const tag = parseSdkVersion(rawTag)
  const latestVersion = tag ? rawTag! : null
  if (minimum && compareBaseVersions(sdk, minimum) < 0) {
    return {status: "unsupported", channel: sdk.channel, latestVersion, minimumSupportedVersion}
  }
  if (!tag) return {status: "unknown", channel: sdk.channel, latestVersion: null, minimumSupportedVersion}
  const status = compareSdkVersions(sdk, tag) < 0 ? "update_available" : "current"
  return {status, channel: sdk.channel, latestVersion, minimumSupportedVersion}
}

// ─── Service ────────────────────────────────────────────────────────────────

/** The subset of `fetch` this module uses; injectable for tests. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

export interface BluetoothSdkUpdateServiceOptions {
  fetch?: Fetcher
  now?: () => number
  /** Reads the minimum supported version; defaults to the environment. */
  minimumSupportedVersion?: () => string | undefined
  /** Reads the PostHog project key; defaults to Core's `POSTHOG_API_KEY`. No key, no record. */
  posthogApiKey?: () => string | undefined
}

export class BluetoothSdkUpdateService {
  private readonly fetcher: Fetcher
  private readonly now: () => number
  private readonly minimumSupportedVersion: () => string | undefined
  private readonly posthogApiKey: () => string | undefined
  private cachedTags: Record<string, string> | null = null
  private fetchedAt = 0
  private failedAt: number | null = null
  private inFlight: Promise<void> | null = null

  constructor(options: BluetoothSdkUpdateServiceOptions = {}) {
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init))
    this.now = options.now ?? Date.now
    this.minimumSupportedVersion =
      options.minimumSupportedVersion ?? (() => process.env[BLUETOOTH_SDK_MIN_SUPPORTED_VERSION_ENV])
    this.posthogApiKey = options.posthogApiKey ?? (() => process.env.POSTHOG_API_KEY?.trim() || undefined)
  }

  /** Builds the response for a validated request. */
  async check(request: UpdateCheckRequest): Promise<UpdateCheckResult> {
    const sdk = parseSdkVersion(request.sdk_version)
    const distTags = sdk ? await this.distTags() : null
    return decideUpdateStatus({
      sdkVersion: request.sdk_version,
      distTags,
      minimumSupportedVersion: this.minimumSupportedVersion(),
    })
  }

  /**
   * The npm dist-tags, cached for 10 minutes. Concurrent callers share one
   * in-flight refresh. A failed refresh keeps the last good value (null if
   * npm has never answered) and is not retried for a minute.
   */
  async distTags(): Promise<Record<string, string> | null> {
    const now = this.now()
    const fresh = this.cachedTags !== null && now - this.fetchedAt < DIST_TAG_CACHE_TTL_MS
    const backingOff = this.failedAt !== null && now - this.failedAt < DIST_TAG_RETRY_AFTER_FAILURE_MS
    if (fresh || backingOff) return this.cachedTags
    this.inFlight ??= this.refresh().finally(() => {
      this.inFlight = null
    })
    await this.inFlight
    return this.cachedTags
  }

  private async refresh(): Promise<void> {
    try {
      const response = await this.fetcher(BLUETOOTH_SDK_DIST_TAGS_URL, {
        method: "GET",
        headers: {accept: "application/json"},
        signal: AbortSignal.timeout(DIST_TAG_FETCH_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`npm dist-tags returned ${response.status}`)
      const body: unknown = await response.json()
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("npm dist-tags body is not an object")
      const tags: Record<string, string> = {}
      for (const [name, version] of Object.entries(body)) {
        if (typeof version === "string") tags[name] = version
      }
      this.cachedTags = tags
      this.fetchedAt = this.now()
      this.failedAt = null
    } catch (error) {
      this.failedAt = this.now()
      logger.warn(
        {error: (error as Error)?.message, hasCachedTags: this.cachedTags !== null},
        "Bluetooth SDK dist-tag refresh failed",
      )
    }
  }

  /**
   * Records one update check in PostHog. Never throws: a lost event must not
   * affect the SDK's response, so callers do not await it.
   */
  async record(request: UpdateCheckRequest, result: UpdateCheckResult): Promise<void> {
    const apiKey = this.posthogApiKey()
    if (!apiKey) return
    try {
      const response = await this.fetcher(BLUETOOTH_SDK_POSTHOG_CAPTURE_URL, {
        method: "POST",
        headers: {"content-type": "application/json"},
        signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
        body: JSON.stringify(captureBody(apiKey, request, result, new Date(this.now()))),
      })
      if (!response.ok) throw new Error(`PostHog capture returned ${response.status}`)
    } catch (error) {
      logger.warn(
        {appIdentifier: request.app_identifier, error: (error as Error)?.message},
        "Bluetooth SDK update check capture dropped",
      )
    }
  }
}

/** The PostHog `/i/v0/e/` single-event body. */
export interface PostHogCaptureBody {
  api_key: string
  uuid: string
  event: string
  distinct_id: string
  timestamp: string
  properties: Record<string, unknown>
}

/** The PostHog `/i/v0/e/` body for one update check. */
export function captureBody(
  apiKey: string,
  request: UpdateCheckRequest,
  result: UpdateCheckResult,
  at: Date,
): PostHogCaptureBody {
  const fields: Record<string, string> = {}
  for (const [key, value] of Object.entries(request)) {
    if (typeof value === "string") fields[key] = value
  }
  return {
    api_key: apiKey,
    uuid: randomUUID(),
    event: BLUETOOTH_SDK_UPDATE_CHECK_EVENT,
    distinct_id: request.install_id,
    timestamp: at.toISOString(),
    properties: {
      ...fields,
      event_source: "mentra_bluetooth_sdk",
      update_status: result.status,
      update_channel: result.channel,
      ...(result.latestVersion ? {latest_version: result.latestVersion} : {}),
      $process_person_profile: false,
      $geoip_disable: true,
    },
  }
}
