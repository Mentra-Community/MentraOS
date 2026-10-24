/**
 * What a miniapp URL serves: the manifest the Mentra App installs from, per the miniapp distribution spec. Fleet's
 * assignment reconciler reads it to decide the version an assignment installs.
 */
import type {FleetAssignmentReason} from "@mentra/cloud-protocol"
import {normalizeMiniappUrl, ServedMiniappManifestSchema} from "@mentra/cloud-protocol/miniapp-url"

import {getConfigValues} from "../runtime/bootstrap"
import {checkManifestVersions} from "./manifestVersionGate"
import {isPackageNameAllowedForUrl} from "./miniappDomainRule"
import {fetchMiniappJson, MiniappFetchError, type MiniappFetchTransport, type MiniappJsonResult} from "./miniappFetch"

/** What a miniapp URL serves now, or the assignment reason it cannot be installed. */
export type MiniappUrlResolution =
  | {ok: true; packageName: string; version: string; bundleUrl: string; bundleSha256: string}
  | {ok: false; reason: FleetAssignmentReason}

/**
 * Read what a miniapp URL serves: `<url>/miniapp.json`, a copy of the manifest in its current ZIP plus
 * `bundle: {url, sha256}` naming that ZIP (relative to `<url>/` or an absolute HTTPS URL), checked with the schema
 * Core checks registrations with. The URL decides the version, and the ZIP must have that SHA-256. The package name
 * must pass the domain rule for the URL and for where its redirects ended.
 *
 * The request carries no Mentra account, token or cookie. A private miniapp's server asks for sign-in with Mentra's
 * challenge; it is answered with the miniapp token of the package it names, which the asking URL's domain must own
 * and the URL must serve. Core names the assigning workspace in that token. The server decides access: a token it
 * refuses (401 or 403) is `access_denied`, and so is a 401 or 403 without the challenge.
 */
export async function resolveMiniappUrl(url: string, transport?: MiniappFetchTransport): Promise<MiniappUrlResolution> {
  // An assignment names a public HTTPS miniapp URL; a local-network build is never assigned.
  const normalized = normalizeMiniappUrl(url)
  if (!normalized || normalized.kind !== "public") return {ok: false, reason: "not_a_miniapp"}
  const manifestUrl = new URL("miniapp.json", normalized.url).href
  let response: MiniappJsonResult
  try {
    response = await fetchMiniappJson(manifestUrl, {packageForChallenge: true, ...(transport ? {transport} : {})})
  } catch (error) {
    if (error instanceof MiniappFetchError) {
      // A challenge for a package its domain doesn't own is the domain rule's refusal.
      if (error.code === "too_large" || error.code === "challenge_domain" || error.code === "challenge_package") {
        return {ok: false, reason: "not_a_miniapp"}
      }
    }
    // Unreachable, or no token to answer with (Core unreachable): try again later.
    return {ok: false, reason: "download_failed"}
  }
  if (response.status === 401 || response.status === 403) return {ok: false, reason: "access_denied"}
  if (response.status === 410) return {ok: false, reason: "archived"}
  if (response.status === 404) return {ok: false, reason: "not_a_miniapp"}
  if (response.status < 200 || response.status >= 300 || response.body === undefined) {
    return {ok: false, reason: "download_failed"}
  }
  const servedFrom = response.url
  let raw: unknown
  try {
    raw = JSON.parse(response.body)
  } catch {
    return {ok: false, reason: "not_a_miniapp"}
  }
  const parsed = ServedMiniappManifestSchema.safeParse(raw)
  if (!parsed.success) return {ok: false, reason: "not_a_miniapp"}
  const manifest = parsed.data
  const {packageName, version} = manifest
  if (!isPackageNameAllowedForUrl(packageName, manifestUrl) || !isPackageNameAllowedForUrl(packageName, servedFrom))
    return {ok: false, reason: "not_a_miniapp"}
  // The token answered a challenge for this package only.
  if (response.challenge && response.challenge.packageName !== packageName) return {ok: false, reason: "not_a_miniapp"}
  let bundleUrl: string
  try {
    const resolved = new URL(manifest.bundle.url.trim(), servedFrom)
    if (resolved.protocol !== "https:") return {ok: false, reason: "not_a_miniapp"}
    bundleUrl = resolved.href
  } catch {
    return {ok: false, reason: "not_a_miniapp"}
  }
  const {hostVersion, supportedMiniappSdkRange} = getConfigValues()
  if (hostVersion && supportedMiniappSdkRange) {
    const versions = checkManifestVersions(manifest, {hostVersion, supportedSdkRange: supportedMiniappSdkRange})
    if (!versions.ok) return {ok: false, reason: "incompatible_host"}
  }
  return {ok: true, packageName, version, bundleUrl, bundleSha256: manifest.bundle.sha256}
}
