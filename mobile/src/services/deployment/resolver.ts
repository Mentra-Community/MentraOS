import {deploymentManifestSchema} from "./schema"
import type {DeploymentCandidate, DeploymentManifest} from "./types"

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
    throw new DeploymentResolutionError("Enter a workspace URL.", "invalid-workspace")
  }

  let url: URL
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`)
  } catch {
    throw new DeploymentResolutionError("The workspace URL is invalid.", "invalid-workspace")
  }

  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
  if (url.protocol !== "https:" && !(allowInsecureLocalhost && isLocalhost && url.protocol === "http:")) {
    throw new DeploymentResolutionError("The workspace must use HTTPS.", "invalid-workspace")
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new DeploymentResolutionError(
      "The workspace URL cannot contain credentials, query parameters, or fragments.",
      "invalid-workspace",
    )
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new DeploymentResolutionError("Enter only the workspace origin, without a path.", "invalid-workspace")
  }

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
  try {
    response = await (options.fetch ?? globalThis.fetch)(manifestUrl, {
      headers: {Accept: "application/json"},
      redirect: "manual",
      signal: controller.signal,
    })
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError" ? "timed out" : "failed"
    throw new DeploymentResolutionError(`Workspace manifest request ${reason}.`, "network")
  } finally {
    clearTimeout(timeout)
  }

  if (response.status >= 300 && response.status < 400) {
    throw new DeploymentResolutionError("Workspace manifest redirects are not allowed.", "redirect")
  }
  if (!response.ok) {
    throw new DeploymentResolutionError(`Workspace manifest returned HTTP ${response.status}.`, "network")
  }
  if (new URL(response.url || manifestUrl).origin !== workspaceOrigin) {
    throw new DeploymentResolutionError("Workspace manifest changed origin.", "redirect")
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new DeploymentResolutionError("Workspace manifest is too large.", "response-too-large")
  }

  const body = await response.text()
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
    throw new DeploymentResolutionError("Workspace manifest is too large.", "response-too-large")
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

function validateDeploymentManifest(
  manifest: DeploymentManifest,
  workspaceOrigin: string,
  allowInsecureLocalhost = false,
): void {
  if (!manifest.services.runtimeUrl) {
    throw new DeploymentResolutionError("This workspace does not configure Runtime.", "invalid-manifest")
  }
  const runtimeOrigin = secureUrlOrigin(manifest.services.runtimeUrl, allowInsecureLocalhost)
  if (runtimeOrigin !== workspaceOrigin) {
    throw new DeploymentResolutionError(
      "Runtime must use the workspace origin in deployment schema v1.",
      "origin-mismatch",
    )
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
    if (!manifest.auth.runtimeScopes.every((scope) => /^api:\/\/[0-9a-f-]{36}\/[a-zA-Z0-9._-]+$/i.test(scope))) {
      throw new DeploymentResolutionError("Runtime scopes must target an application API scope.", "invalid-manifest")
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
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
  if (url.username || url.password || url.hash) {
    throw new DeploymentResolutionError("Configured URLs cannot contain credentials or fragments.", "invalid-manifest")
  }
  if (url.protocol !== "https:" && !(allowInsecureLocalhost && isLocalhost && url.protocol === "http:")) {
    throw new DeploymentResolutionError("Configured URLs must use HTTPS.", "invalid-manifest")
  }
  return url.origin
}

function allConfiguredUrls(manifest: DeploymentManifest): string[] {
  return [
    manifest.services.coreUrl,
    manifest.services.runtimeUrl,
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
  ].filter((url): url is string => url !== null)
}
