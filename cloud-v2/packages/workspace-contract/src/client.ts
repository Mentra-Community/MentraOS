/** Signed client for Core's internal workspace service API (`/api/internal/workspaces/*`). */
import type {WorkspaceCapability, WorkspaceRole} from "./capabilities"
import {SERVICE_HEADERS, signServiceRequest} from "./service-signature"
import type {
  AuthorizeRequest,
  AuthorizeResponse,
  PrincipalResponse,
  WorkspaceChangeEvent,
  WorkspaceSummary,
} from "./types"

const API_PREFIX = "/api/internal/workspaces"
const DEFAULT_TIMEOUT_MS = 5_000

export type CoreWorkspaceClientErrorCode =
  /** A response carried an organizationId other than the one this client is bound to. */
  | "organization_mismatch"
  /** Core could not be reached, timed out, or answered with a 5xx. */
  | "core_unavailable"
  /** Core rejected the service signature (HTTP 401). */
  | "unauthorized"
  /** This service is not allowed to call the endpoint (HTTP 403). */
  | "forbidden"
  /** Core rejected the request itself (other 4xx). */
  | "bad_request"
  /** The response was not valid JSON or did not have the documented shape. */
  | "bad_response"

export class CoreWorkspaceClientError extends Error {
  readonly code: CoreWorkspaceClientErrorCode
  readonly status: number | undefined

  constructor(code: CoreWorkspaceClientErrorCode, message: string, status?: number) {
    super(message)
    this.name = "CoreWorkspaceClientError"
    this.code = code
    this.status = status
  }
}

export interface CoreWorkspaceClient {
  authorize(req: AuthorizeRequest): Promise<AuthorizeResponse>
  /** Null when Core does not accept the token (HTTP 401). */
  resolvePrincipal(bearerToken: string): Promise<PrincipalResponse | null>
  checkMemberships(
    mentraUserId: string,
    workspaceIds: string[],
  ): Promise<Record<string, {role: WorkspaceRole; capabilities: WorkspaceCapability[]} | null>>
  /** Null when the workspace does not exist (HTTP 404). */
  getWorkspace(workspaceId: string): Promise<WorkspaceSummary | null>
  listChanges(after: string | null, limit?: number): Promise<{events: WorkspaceChangeEvent[]; next: string | null}>
  mintServiceCredential(input: {
    workspaceId: string
    name: string
    packageNames: string[]
    issuedBy: {service: string; actorEmail: string}
  }): Promise<{credentialId: string; token: string}>
}

export interface CoreWorkspaceClientOptions {
  /** Core's origin, e.g. `https://core.example.com`. Signed paths start at `/api/internal/workspaces`. */
  baseUrl: string
  /** Sent as `x-mentra-service`; must be a service Core has a secret for. */
  service: string
  secret: string
  /** Every response that names an organization must name this one. */
  expectedOrganizationId: string
  fetch?: typeof fetch
  timeoutMs?: number
}

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

export function createCoreWorkspaceClient(opts: CoreWorkspaceClientOptions): CoreWorkspaceClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "")
  const doFetch = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const badResponse = (path: string, detail: string) =>
    new CoreWorkspaceClientError("bad_response", `Core ${path} returned an invalid response: ${detail}`)

  function checkOrganization(path: string, value: unknown, what: string) {
    if (typeof value !== "string") throw badResponse(path, `${what} has no organizationId`)
    if (value !== opts.expectedOrganizationId) {
      throw new CoreWorkspaceClientError(
        "organization_mismatch",
        `Core ${path} returned ${what} for organization ${value}, expected ${opts.expectedOrganizationId}`,
      )
    }
  }

  function checkOwned(path: string, value: unknown, what: string): Json {
    if (!isRecord(value)) throw badResponse(path, `${what} is not an object`)
    checkOrganization(path, value.organizationId, what)
    return value
  }

  /** Sends one signed request. Resolves to the parsed JSON body, or null when `nullOn` matches the status. */
  async function call(
    method: "GET" | "POST",
    pathWithQuery: string,
    payload?: unknown,
    nullOn?: number,
  ): Promise<unknown> {
    const body = payload === undefined ? "" : JSON.stringify(payload)
    const timestampMs = Date.now()
    const headers: Record<string, string> = {
      accept: "application/json",
      [SERVICE_HEADERS.service]: opts.service,
      [SERVICE_HEADERS.timestamp]: String(timestampMs),
      [SERVICE_HEADERS.signature]: signServiceRequest({
        secret: opts.secret,
        method,
        pathWithQuery,
        body,
        timestampMs,
      }),
    }
    if (method === "POST") headers["content-type"] = "application/json"

    let status: number
    let text: string
    try {
      const response = await doFetch(`${baseUrl}${pathWithQuery}`, {
        method,
        headers,
        body: method === "POST" ? body : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      })
      status = response.status
      text = await response.text()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new CoreWorkspaceClientError("core_unavailable", `Core ${pathWithQuery} is unreachable: ${reason}`)
    }

    if (nullOn !== undefined && status === nullOn) return null
    if (status < 200 || status >= 300) throw httpError(pathWithQuery, status, text)
    try {
      return JSON.parse(text)
    } catch {
      throw badResponse(pathWithQuery, "body is not JSON")
    }
  }

  function httpError(path: string, status: number, text: string) {
    let detail = ""
    try {
      const parsed: unknown = JSON.parse(text)
      if (isRecord(parsed) && typeof parsed.error === "string") detail = `: ${parsed.error}`
    } catch {
      // Not JSON; the status alone is the detail.
    }
    const message = `Core ${path} failed with HTTP ${status}${detail}`
    if (status >= 500) return new CoreWorkspaceClientError("core_unavailable", message, status)
    if (status === 401) return new CoreWorkspaceClientError("unauthorized", message, status)
    if (status === 403) return new CoreWorkspaceClientError("forbidden", message, status)
    return new CoreWorkspaceClientError("bad_request", message, status)
  }

  return {
    async authorize(req) {
      const path = `${API_PREFIX}/authorize`
      const body = checkOwned(path, await call("POST", path, req), "the authorize response")
      if (typeof body.allowed !== "boolean" || !Array.isArray(body.capabilities)) {
        throw badResponse(path, "missing allowed or capabilities")
      }
      if (body.principal !== null && body.principal !== undefined) checkOwned(path, body.principal, "the principal")
      if (body.workspace !== undefined) checkOwned(path, body.workspace, "the workspace")
      return body as unknown as AuthorizeResponse
    },

    async resolvePrincipal(bearerToken) {
      const path = `${API_PREFIX}/principal`
      const raw = await call("POST", path, {token: bearerToken}, 401)
      if (raw === null) return null
      if (!isRecord(raw) || !Array.isArray(raw.workspaces)) throw badResponse(path, "missing principal or workspaces")
      checkOwned(path, raw.principal, "the principal")
      for (const workspace of raw.workspaces) checkOwned(path, workspace, "a workspace")
      return raw as unknown as PrincipalResponse
    },

    async checkMemberships(mentraUserId, workspaceIds) {
      const path = `${API_PREFIX}/memberships/check`
      const raw = await call("POST", path, {mentraUserId, workspaceIds})
      if (!isRecord(raw)) throw badResponse(path, "the memberships are not an object")
      return raw as Awaited<ReturnType<CoreWorkspaceClient["checkMemberships"]>>
    },

    async getWorkspace(workspaceId) {
      const path = `${API_PREFIX}/workspaces/${encodeURIComponent(workspaceId)}`
      const raw = await call("GET", path, undefined, 404)
      if (raw === null) return null
      return checkOwned(path, raw, "the workspace") as unknown as WorkspaceSummary
    },

    async listChanges(after, limit) {
      const query = new URLSearchParams()
      if (after !== null) query.set("after", after)
      if (limit !== undefined) query.set("limit", String(limit))
      const queryString = query.toString()
      const path = `${API_PREFIX}/changes${queryString ? `?${queryString}` : ""}`
      const raw = await call("GET", path)
      if (!isRecord(raw) || !Array.isArray(raw.events)) throw badResponse(path, "missing events")
      if (raw.next !== null && typeof raw.next !== "string") throw badResponse(path, "next is not a string or null")
      for (const event of raw.events) checkOwned(path, event, "an event")
      return {events: raw.events as WorkspaceChangeEvent[], next: raw.next}
    },

    async mintServiceCredential(input) {
      const path = `${API_PREFIX}/credentials`
      const raw = await call("POST", path, input)
      if (!isRecord(raw) || typeof raw.credentialId !== "string" || typeof raw.token !== "string") {
        throw badResponse(path, "missing credentialId or token")
      }
      return {credentialId: raw.credentialId, token: raw.token}
    },
  }
}
