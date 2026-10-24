/**
 * What a miniapp URL serves: the manifest the Mentra App installs from, per the miniapp distribution spec. Fleet's
 * assignment reconciler reads it to decide the version an assignment installs.
 */
import type {FleetAssignmentReason} from "@mentra/cloud-protocol"
import {normalizeMiniappUrl} from "@mentra/cloud-protocol/miniapp-url"
import semver from "semver"

import {getConfigValues} from "../runtime/bootstrap"
import {checkManifestVersions} from "./manifestVersionGate"
import {isPackageNameAllowedForUrl} from "./miniappDomainRule"

/** What a miniapp URL serves now, or the assignment reason it cannot be installed. */
export type MiniappUrlResolution =
  | {ok: true; packageName: string; version: string; bundleUrl: string; bundleSha256: string}
  | {ok: false; reason: FleetAssignmentReason}

const URL_RESOLVE_TIMEOUT_MS = 20_000
const SHA256_HEX = /^[a-f0-9]{64}$/

/**
 * Read what a miniapp URL serves: `<url>/miniapp.json`, a copy of the manifest in its current ZIP plus
 * `bundle: {url, sha256}` naming that ZIP (relative to `<url>/` or an absolute HTTPS URL). The URL decides the
 * version, and the ZIP must have that SHA-256. The server decides access: 401 and 403 are `access_denied`. The
 * package name must pass the domain rule for the URL and for where its redirects ended.
 *
 * The request carries no Mentra token and answers no sign-in challenge, so a private host cannot tell who is asking:
 * answering the challenge with the package's miniapp token is Phase 17 (miniapp distribution "Sign-in challenges").
 */
export async function resolveMiniappUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<MiniappUrlResolution> {
  // An assignment names a public HTTPS miniapp URL; a local-network build is never assigned.
  const normalized = normalizeMiniappUrl(url)
  if (!normalized || normalized.kind !== "public") return {ok: false, reason: "not_a_miniapp"}
  const manifestUrl = new URL("miniapp.json", normalized.url).href
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), URL_RESOLVE_TIMEOUT_MS)
  let manifest: Record<string, unknown>
  let servedFrom: string
  try {
    const response = await fetchImpl(manifestUrl, {
      signal: controller.signal,
      headers: {"Accept": "application/json", "Cache-Control": "no-cache"},
    })
    if (response.status === 401 || response.status === 403) return {ok: false, reason: "access_denied"}
    if (response.status === 410) return {ok: false, reason: "archived"}
    if (response.status === 404) return {ok: false, reason: "not_a_miniapp"}
    if (!response.ok) return {ok: false, reason: "download_failed"}
    servedFrom = response.url || manifestUrl
    try {
      const parsed = (await response.json()) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {ok: false, reason: "not_a_miniapp"}
      manifest = parsed as Record<string, unknown>
    } catch {
      return {ok: false, reason: "not_a_miniapp"}
    }
  } catch {
    return {ok: false, reason: "download_failed"}
  } finally {
    clearTimeout(timeout)
  }
  const packageName = typeof manifest.packageName === "string" ? manifest.packageName.trim() : ""
  const version = typeof manifest.version === "string" ? manifest.version.trim() : ""
  if (!packageName || !semver.valid(version)) return {ok: false, reason: "not_a_miniapp"}
  if (!isPackageNameAllowedForUrl(packageName, manifestUrl) || !isPackageNameAllowedForUrl(packageName, servedFrom))
    return {ok: false, reason: "not_a_miniapp"}
  const bundle = manifest.bundle as Record<string, unknown> | null | undefined
  const sha = typeof bundle?.sha256 === "string" ? bundle.sha256.trim().toLowerCase() : ""
  const bundlePath = typeof bundle?.url === "string" ? bundle.url.trim() : ""
  if (!SHA256_HEX.test(sha) || !bundlePath) return {ok: false, reason: "not_a_miniapp"}
  let bundleUrl: string
  try {
    const resolved = new URL(bundlePath, servedFrom)
    if (resolved.protocol !== "https:") return {ok: false, reason: "not_a_miniapp"}
    bundleUrl = resolved.href
  } catch {
    return {ok: false, reason: "not_a_miniapp"}
  }
  const {hostVersion, supportedMiniappSdkRange} = getConfigValues()
  if (hostVersion && supportedMiniappSdkRange) {
    const versions = checkManifestVersions(
      {
        sdkVersion: typeof manifest.sdkVersion === "string" ? manifest.sdkVersion : undefined,
        minHostVersion: typeof manifest.minHostVersion === "string" ? manifest.minHostVersion : undefined,
      },
      {hostVersion, supportedSdkRange: supportedMiniappSdkRange},
    )
    if (!versions.ok) return {ok: false, reason: "incompatible_host"}
  }
  return {ok: true, packageName, version, bundleUrl, bundleSha256: sha}
}
