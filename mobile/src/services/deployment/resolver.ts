import {deploymentManifestSchema} from "./schema"
import type {DeploymentCandidate, DeploymentManifest} from "./types"
import {SYSTEM_APPS} from "@/constants/miniapps"

const MANIFEST_PATH = "/.well-known/mentra-deployment.json"
const DEFAULT_MAX_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 10_000
const REQUIRED_ACS_TEAMS_SCOPES = new Set([
  "https://auth.msft.communication.azure.com/Teams.ManageCalls",
  "https://auth.msft.communication.azure.com/Teams.ManageChats",
])

export class DeploymentResolutionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid-workspace"
      | "network"
      | "not-found"
      | "redirect"
      | "response-too-large"
      | "invalid-manifest"
      | "origin-mismatch",
  ) {
    super(message)
    this.name = "DeploymentResolutionError"
  }
}

export interface ResolveDeploymentOptions {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  timeoutMs?: number
  maxBytes?: number
  allowInsecureLocalhost?: boolean
}

export function normalizeWorkspaceOrigin(input: string, allowInsecureLocalhost = false): string {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new DeploymentResolutionError("Enter an organization address.", "invalid-workspace")
  }

  let url: URL
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`)
  } catch {
    throw new DeploymentResolutionError("Enter a valid organization address.", "invalid-workspace")
  }

  const isLocalhost = isLoopbackHostname(url.hostname)
  if (url.protocol !== "https:" && !(allowInsecureLocalhost && isLocalhost && url.protocol === "http:")) {
    throw new DeploymentResolutionError("The organization address must use HTTPS.", "invalid-workspace")
  }
  if (url.username || url.password) {
    throw new DeploymentResolutionError(
      "Enter an organization address without a username or password.",
      "invalid-workspace",
    )
  }

  // People commonly paste a homepage or the complete well-known manifest URL.
  // Discovery is origin-based, so paths, queries, and fragments are irrelevant.
  return url.origin
}

export async function resolveDeploymentCandidate(
  workspaceInput: string,
  options: ResolveDeploymentOptions,
): Promise<DeploymentCandidate> {
  const workspaceOrigin = normalizeWorkspaceOrigin(workspaceInput, options.allowInsecureLocalhost)
  const manifestUrl = new URL(MANIFEST_PATH, workspaceOrigin).toString()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  let response: Response
  let body: string
  try {
    response = await (options.fetch ?? globalThis.fetch)(manifestUrl, {
      headers: {Accept: "application/json"},
      redirect: "manual",
      signal: controller.signal,
    })
    if (response.status >= 300 && response.status < 400) {
      throw new DeploymentResolutionError("Workspace manifest redirects are not allowed.", "redirect")
    }
    if (response.status === 404 || response.status === 410) {
      throw new DeploymentResolutionError("No workspace manifest exists at this address.", "not-found")
    }
    if (!response.ok) {
      throw new DeploymentResolutionError(`Workspace manifest returned HTTP ${response.status}.`, "network")
    }
    if (new URL(response.url || manifestUrl).origin !== workspaceOrigin) {
      throw new DeploymentResolutionError("Workspace manifest changed origin.", "redirect")
    }

    body = await readResponseBody(response, options.maxBytes ?? DEFAULT_MAX_BYTES)
  } catch (error) {
    if (error instanceof DeploymentResolutionError) throw error
    const reason = error instanceof Error && error.name === "AbortError" ? "timed out" : "failed"
    throw new DeploymentResolutionError(`Workspace manifest request ${reason}.`, "network")
  } finally {
    clearTimeout(timeout)
  }

  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    throw new DeploymentResolutionError("Workspace manifest is not valid JSON.", "invalid-manifest")
  }

  const parsed = deploymentManifestSchema.safeParse(raw)
  if (!parsed.success) {
    throw new DeploymentResolutionError("Workspace manifest does not match the supported schema.", "invalid-manifest")
  }

  validateDeploymentManifest(parsed.data, workspaceOrigin, options.allowInsecureLocalhost)
  return {workspaceOrigin, manifestUrl, manifest: parsed.data}
}

export function validateDeploymentManifest(
  manifest: DeploymentManifest,
  workspaceOrigin: string,
  allowInsecureLocalhost = false,
): void {
  if (!manifest.services.coreUrl) {
    throw new DeploymentResolutionError("This workspace does not configure Core.", "invalid-manifest")
  }
  if (!manifest.services.runtimeUrl) {
    throw new DeploymentResolutionError("This workspace does not configure Runtime.", "invalid-manifest")
  }
  secureServiceBaseUrl(manifest.services.coreUrl, allowInsecureLocalhost)
  const runtimeOrigin = secureServiceBaseUrl(manifest.services.runtimeUrl, allowInsecureLocalhost)
  if (runtimeOrigin !== workspaceOrigin) {
    throw new DeploymentResolutionError(
      "Runtime must use the workspace origin in deployment schema v1.",
      "origin-mismatch",
    )
  }
  if (manifest.branding) {
    const logoOrigins = Object.values(manifest.branding.logoUrls).map((logoUrl) =>
      secureUrlOrigin(logoUrl, allowInsecureLocalhost),
    )
    if (logoOrigins.some((origin) => origin !== workspaceOrigin)) {
      throw new DeploymentResolutionError(
        "Workspace logos must use the workspace origin in deployment schema v1.",
        "origin-mismatch",
      )
    }
  }
  const managedPackageNames = new Set<string>()
  const managedBundlePaths = new Set<string>()
  for (const entry of manifest.miniapps.managed) {
    if (managedPackageNames.has(entry.packageName)) {
      throw new DeploymentResolutionError(
        `Managed miniapp ${entry.packageName} is listed more than once.`,
        "invalid-manifest",
      )
    }
    managedPackageNames.add(entry.packageName)
    const bundleUrl = new URL(entry.bundleUrl)
    if (secureUrlOrigin(entry.bundleUrl, allowInsecureLocalhost) !== workspaceOrigin) {
      throw new DeploymentResolutionError(
        "Managed miniapp bundles must use the workspace origin in deployment schema v1.",
        "origin-mismatch",
      )
    }
    if (!bundleUrl.pathname.startsWith("/miniapps/") || bundleUrl.pathname.endsWith("/")) {
      throw new DeploymentResolutionError(
        "Managed miniapp bundle URLs must use a file path under /miniapps/.",
        "invalid-manifest",
      )
    }
    if (managedBundlePaths.has(bundleUrl.pathname)) {
      throw new DeploymentResolutionError(
        `Managed miniapp bundle path ${bundleUrl.pathname} is listed more than once.`,
        "invalid-manifest",
      )
    }
    managedBundlePaths.add(bundleUrl.pathname)
  }
  const approvedSystemMiniapps = manifest.systemMiniapps.approvedPackageNamesOverride
  const systemPackageNames = new Set<string>(SYSTEM_APPS)
  if (
    [...managedPackageNames].some((packageName) => systemPackageNames.has(packageName)) ||
    approvedSystemMiniapps?.some((packageName) => managedPackageNames.has(packageName))
  ) {
    throw new DeploymentResolutionError(
      "A built-in system miniapp cannot be replaced by a manifest-managed userland miniapp.",
      "invalid-manifest",
    )
  }
  if (approvedSystemMiniapps !== null) {
    const approvedPackages = new Set([...approvedSystemMiniapps, ...managedPackageNames])
    const orphanedConfiguration = Object.keys(manifest.miniapps.configuration).find(
      (packageName) => !approvedPackages.has(packageName),
    )
    if (orphanedConfiguration) {
      throw new DeploymentResolutionError(
        `Miniapp configuration targets unapproved package ${orphanedConfiguration}.`,
        "invalid-manifest",
      )
    }
  }
  for (const url of allConfiguredUrls(manifest)) {
    secureUrlOrigin(url, allowInsecureLocalhost)
  }
  if (manifest.auth.mode !== "microsoft-entra") {
    throw new DeploymentResolutionError(
      "This Mentra App release does not support the workspace authentication mode.",
      "invalid-manifest",
    )
  }
  if (manifest.auth.mode === "microsoft-entra") {
    const authority = new URL(manifest.auth.authorityUrl)
    const authoritySegments = authority.pathname.split("/").filter(Boolean)
    const tenant = authoritySegments[0]
    if (
      authority.origin !== "https://login.microsoftonline.com" ||
      authoritySegments.length !== 1 ||
      !tenant ||
      tenant === "common" ||
      tenant === "organizations" ||
      tenant === "consumers"
    ) {
      throw new DeploymentResolutionError("Microsoft Entra authority must name an exact tenant.", "invalid-manifest")
    }
    if (!manifest.auth.sessionScopes.every((scope) => /^api:\/\/[0-9a-f-]{36}\/[a-zA-Z0-9._-]+$/i.test(scope))) {
      throw new DeploymentResolutionError("Session scopes must target an application API scope.", "invalid-manifest")
    }
    const teamsScopes = new Set(manifest.auth.teamsScopes)
    const validTeamsScopes =
      teamsScopes.size === manifest.auth.teamsScopes.length &&
      [...teamsScopes].every((scope) => REQUIRED_ACS_TEAMS_SCOPES.has(scope))
    if (!validTeamsScopes) {
      throw new DeploymentResolutionError(
        "Microsoft Teams scopes are not supported by deployment schema v1.",
        "invalid-manifest",
      )
    }
    if (manifest.features.nativeMeetings && [...REQUIRED_ACS_TEAMS_SCOPES].some((scope) => !teamsScopes.has(scope))) {
      throw new DeploymentResolutionError(
        "Native Teams meetings require the Teams calling and chat delegated scopes.",
        "invalid-manifest",
      )
    }
  }
}

function secureUrlOrigin(value: string, allowInsecureLocalhost = false): string {
  const url = new URL(value)
  const isLocalhost = isLoopbackHostname(url.hostname)
  if (url.username || url.password || url.hash) {
    throw new DeploymentResolutionError("Configured URLs cannot contain credentials or fragments.", "invalid-manifest")
  }
  if (url.protocol !== "https:" && !(allowInsecureLocalhost && isLocalhost && url.protocol === "http:")) {
    throw new DeploymentResolutionError("Configured URLs must use HTTPS.", "invalid-manifest")
  }
  return url.origin
}

function secureServiceBaseUrl(value: string, allowInsecureLocalhost = false): string {
  const url = new URL(value)
  secureUrlOrigin(value, allowInsecureLocalhost)
  if ((url.pathname !== "" && url.pathname !== "/") || url.search || url.hash) {
    throw new DeploymentResolutionError(
      "Core and Runtime URLs must be origins without a path, query, or fragment.",
      "invalid-manifest",
    )
  }
  return url.origin
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"
}

async function readResponseBody(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new DeploymentResolutionError("Workspace manifest is too large.", "response-too-large")
  }

  const reader = response.body?.getReader()
  if (!reader) {
    // React Native's fetch implementation does not expose Response.body as a
    // ReadableStream. Reject an advertised oversized response before reading,
    // then enforce the same limit after materializing the body. Browser-like
    // runtimes continue to use the bounded streaming path below.
    const value = await response.text()
    if (utf8ByteLength(value) > maxBytes) {
      throw new DeploymentResolutionError("Workspace manifest is too large.", "response-too-large")
    }
    return value
  }

  const decoder = new TextDecoder("utf-8", {fatal: true})
  let byteLength = 0
  let value = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      byteLength += chunk.value.byteLength
      if (byteLength > maxBytes) {
        await reader.cancel()
        throw new DeploymentResolutionError("Workspace manifest is too large.", "response-too-large")
      }
      value += decoder.decode(chunk.value, {stream: true})
    }
    value += decoder.decode()
    return value
  } catch (error) {
    if (error instanceof DeploymentResolutionError) throw error
    throw new DeploymentResolutionError("Workspace manifest body is not valid UTF-8.", "invalid-manifest")
  }
}

function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit < 0x80) {
      bytes += 1
    } else if (codeUnit < 0x800) {
      bytes += 2
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
      const nextCodeUnit = value.charCodeAt(index + 1)
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}

function allConfiguredUrls(manifest: DeploymentManifest): string[] {
  return [
    manifest.services.coreUrl,
    manifest.services.runtimeUrl,
    manifest.branding?.logoUrls.light ?? null,
    manifest.branding?.logoUrls.dark ?? null,
    manifest.artifacts.mentraLiveOtaManifestUrl,
    manifest.artifacts.sttModelBaseUrl,
    manifest.artifacts.ttsModelBaseUrl,
    manifest.appUpdates.storeUrls.android,
    manifest.appUpdates.storeUrls.ios,
    manifest.appUpdates.reviewUrls.android,
    manifest.appUpdates.reviewUrls.ios,
    manifest.links.privacyPolicyUrl,
    manifest.links.termsOfServiceUrl,
    manifest.links.documentationUrl,
    manifest.links.supportUrl,
    ...manifest.content.wallpaperUrls,
    ...manifest.miniapps.managed.map((entry) => entry.bundleUrl),
  ].filter((url): url is string => url !== null)
}
