/** Signed client for Core's internal workspace service API (`/api/internal/workspaces/*`). */
import {SERVICE_HEADERS, signServiceRequest} from "./service-signature"
import {INVALID_TOKEN_ERROR, SERVICE_UNAUTHORIZED_ERROR, WORKSPACE_NOT_FOUND_ERROR} from "./types"
import type {
  AuthorizeRequest,
  AuthorizeResponse,
  MembershipCheckEntry,
  PrincipalResponse,
  WorkspaceChangeEvent,
  WorkspaceSummary,
} from "./types"

const API_PREFIX = "/api/internal/workspaces"
const DEFAULT_TIMEOUT_MS = 5_000

export type CoreWorkspaceClientErrorCode =
  /** Core could not be reached, timed out, or answered with a 5xx. */
  | "core_unavailable"
  /** Core rejected this service's signature or secret (HTTP 401 `service_unauthorized`). */
  | "service_unauthorized"
  /** Core answered 401 for another reason. */
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
  /** Null only when Core says the token is invalid (HTTP 401 `invalid_token`); other 401s throw. */
  resolvePrincipal(bearerToken: string): Promise<PrincipalResponse | null>
  checkMemberships(mentraUserId: string, workspaceIds: string[]): Promise<Record<string, MembershipCheckEntry | null>>
  /** Null only when Core says the workspace does not exist (HTTP 404 `workspace_not_found`); any other 404 throws. */
  getWorkspace(workspaceId: string): Promise<WorkspaceSummary | null>
  /**
   * Events after the cursor in `seq` order. `after` is the last processed event's `seq` as a decimal
   * string (null starts from the beginning); `next` is the cursor for the following page, or null when
   * the page was not full.
   */
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
  fetch?: typeof fetch
  timeoutMs?: number
}

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

export function createCoreWorkspaceClient(opts: CoreWorkspaceClientOptions): CoreWorkspaceClient {
  if (opts.secret.trim().length === 0) throw new Error("A Core workspace client needs a non-empty service secret")
  const baseUrl = opts.baseUrl.replace(/\/+$/, "")
  const doFetch = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const badResponse = (path: string, detail: string) =>
    new CoreWorkspaceClientError("bad_response", `Core ${path} returned an invalid response: ${detail}`)

  function checkRecord(path: string, value: unknown, what: string): Json {
    if (!isRecord(value)) throw badResponse(path, `${what} is not an object`)
    return value
  }

  function checkPrincipal(path: string, value: unknown): Json {
    const principal = checkRecord(path, value, "the principal")
    if (principal.kind !== "user" && principal.kind !== "credential") {
      throw badResponse(path, "the principal is neither a user nor a credential")
    }
    return principal
  }

  function checkWorkspace(path: string, value: unknown, what: string): Json {
    const workspace = checkRecord(path, value, what)
    if (typeof workspace.workspaceId !== "string") throw badResponse(path, `${what} has no workspaceId`)
    return workspace
  }

  /** Sends one signed request. Resolves to the parsed JSON body, or null when `nullOn` accepts the failure. */
  async function call(
    method: "GET" | "POST",
    pathWithQuery: string,
    payload?: unknown,
    nullOn?: (status: number, error: string | undefined) => boolean,
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

    if (status < 200 || status >= 300) {
      if (nullOn?.(status, errorCode(text))) return null
      throw httpError(pathWithQuery, status, text)
    }
    try {
      return JSON.parse(text)
    } catch {
      throw badResponse(pathWithQuery, "body is not JSON")
    }
  }

  /** The `error` string of a JSON error body, if there is one. */
  function errorCode(text: string): string | undefined {
    try {
      const parsed: unknown = JSON.parse(text)
      if (isRecord(parsed) && typeof parsed.error === "string") return parsed.error
    } catch {
      // Not JSON; the status alone describes the failure.
    }
    return undefined
  }

  function httpError(path: string, status: number, text: string) {
    const error = errorCode(text)
    const message = `Core ${path} failed with HTTP ${status}${error ? `: ${error}` : ""}`
    if (status >= 500) return new CoreWorkspaceClientError("core_unavailable", message, status)
    if (status === 401) {
      const code = error === SERVICE_UNAUTHORIZED_ERROR ? "service_unauthorized" : "unauthorized"
      return new CoreWorkspaceClientError(code, message, status)
    }
    if (status === 403) return new CoreWorkspaceClientError("forbidden", message, status)
    return new CoreWorkspaceClientError("bad_request", message, status)
  }

  return {
    async authorize(req) {
      const path = `${API_PREFIX}/authorize`
      const body = checkRecord(path, await call("POST", path, req), "the authorize response")
      if (typeof body.allowed !== "boolean" || !Array.isArray(body.capabilities)) {
        throw badResponse(path, "missing allowed or capabilities")
      }
      if (body.principal !== null && body.principal !== undefined) checkPrincipal(path, body.principal)
      if (body.workspace !== null && body.workspace !== undefined) checkWorkspace(path, body.workspace, "the workspace")
      return body as unknown as AuthorizeResponse
    },

    async resolvePrincipal(bearerToken) {
      const path = `${API_PREFIX}/principal`
      const raw = await call(
        "POST",
        path,
        {token: bearerToken},
        (status, error) => status === 401 && error === INVALID_TOKEN_ERROR,
      )
      if (raw === null) return null
      if (!isRecord(raw) || !Array.isArray(raw.workspaces)) throw badResponse(path, "missing principal or workspaces")
      checkPrincipal(path, raw.principal)
      for (const workspace of raw.workspaces) checkWorkspace(path, workspace, "a workspace")
      return raw as unknown as PrincipalResponse
    },

    async checkMemberships(mentraUserId, workspaceIds) {
      const path = `${API_PREFIX}/memberships/check`
      const raw = checkRecord(path, await call("POST", path, {mentraUserId, workspaceIds}), "the membership check")
      if (!isRecord(raw.memberships)) throw badResponse(path, "the memberships are not an object")
      return raw.memberships as Record<string, MembershipCheckEntry | null>
    },

    async getWorkspace(workspaceId) {
      const path = `${API_PREFIX}/workspaces/${encodeURIComponent(workspaceId)}`
      const raw = await call(
        "GET",
        path,
        undefined,
        (status, error) => status === 404 && error === WORKSPACE_NOT_FOUND_ERROR,
      )
      if (raw === null) return null
      return checkWorkspace(path, raw, "the workspace") as unknown as WorkspaceSummary
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
      for (const event of raw.events) {
        const checked = checkRecord(path, event, "an event")
        if (typeof checked.eventId !== "string" || typeof checked.seq !== "number") {
          throw badResponse(path, "an event has no eventId or seq")
        }
      }
      return {events: raw.events as WorkspaceChangeEvent[], next: raw.next}
    },

    async mintServiceCredential(input) {
      const path = `${API_PREFIX}/credentials`
      const raw = checkRecord(path, await call("POST", path, input), "the credential")
      if (typeof raw.credentialId !== "string" || typeof raw.token !== "string") {
        throw badResponse(path, "missing credentialId or token")
      }
      return {credentialId: raw.credentialId, token: raw.token}
    },
  }
}
