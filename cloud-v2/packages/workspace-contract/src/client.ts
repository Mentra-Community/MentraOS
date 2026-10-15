/**
 * Signed client for Core's internal workspace service API (`/api/internal/workspaces/*`), for a service
 * that shares a secret with its Core (the Store, Fleet). Every request is signed over its timestamp, method,
 * path and body hash (`service-signature.ts`); no request names an organization.
 */
import {isWorkspaceDeletionHold} from "./deletion-holds"
import {SERVICE_HEADERS, signServiceRequest} from "./service-signature"
import {INVALID_TOKEN_ERROR, SERVICE_UNAUTHORIZED_ERROR, USER_NOT_FOUND_ERROR, WORKSPACE_NOT_FOUND_ERROR} from "./types"
import type {
  AuthorizeRequest,
  AuthorizeResponse,
  DeletionHoldsResponse,
  DeletionHoldUpdate,
  MembershipCheckEntry,
  PrincipalResponse,
  WorkspaceChangeEvent,
  WorkspaceChangesResponse,
  WorkspaceSummary,
} from "./types"

const API_PREFIX = "/api/internal/workspaces"
/** A feed cursor: a `seq` as a decimal string, with no sign, leading zero or fraction. */
const CURSOR = /^[1-9]\d*$/
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
   * One page of the change feed, oldest first. `after` is the `seq` of the last event already
   * processed, as a decimal string (omitted or null starts from the beginning); `limit` is at most 500
   * (Core's default when omitted is 100). `next` is the cursor for the following page, or null when
   * the page was not full. Store a cursor only after the events up to it are processed.
   */
  listChanges(input: {after?: string | null; limit?: number}): Promise<WorkspaceChangesResponse>
  mintServiceCredential(input: {
    workspaceId: string
    name: string
    packageNames: string[]
    issuedBy: {service: string; actorEmail: string}
  }): Promise<{credentialId: string; token: string}>
  /**
   * The Mentra user id of the account whose verified email this is (Core creates the Mentra user on
   * first use). Null only when Core says no account has it verified (HTTP 404 `user_not_found`).
   */
  resolveEmail(email: string): Promise<string | null>
  /**
   * Hold the workspace from deletion for this service, replacing its previous hold: while any service
   * holds a workspace, Core refuses to delete it (409 `workspace_has_holds`). `reason` is a lowercase
   * code (`owns_miniapps`); `count`, when given, is a positive whole number of what the reason names.
   * `asOf` is when the service computed the hold, taken just before reading what it counts and later
   * than the service's previous `asOf` for the workspace: Core ignores the call (`ignored: true`,
   * changing nothing) when it has applied a newer one from this service, so a late call never
   * overwrites a newer hold. A caller that needs the workspace held must find its own hold in the
   * answer's `holds`, which an ignored call does not promise. Setting the hold the service already has
   * changes no hold. Resolves to every hold on the workspace afterwards. Core refuses an unknown
   * workspace (404), a deleted one (410) and an `asOf` more than five minutes ahead of its clock
   * (400). An invalid `asOf` throws a `RangeError` before anything is sent.
   */
  setDeletionHold(workspaceId: string, hold: {reason: string; count?: number; asOf: Date}): Promise<DeletionHoldsResponse>
  /**
   * Clear this service's hold, if it has one (clearing nothing changes no hold, on a deleted workspace
   * too). `asOf` is as for `setDeletionHold`: Core remembers it after the clear, so a set computed
   * before it and applied late is ignored too. Resolves to the holds left on the workspace. Core
   * refuses an unknown workspace (404).
   */
  clearDeletionHold(workspaceId: string, update: {asOf: Date}): Promise<DeletionHoldsResponse>
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

  /** A record or null: the shape of an event's `target`, `before` and `after`. */
  function checkSnapshot(path: string, value: unknown, what: string): void {
    if (value !== null) checkRecord(path, value, what)
  }

  function checkChangeEvent(path: string, value: unknown): WorkspaceChangeEvent {
    const event = checkRecord(path, value, "an event")
    if (typeof event.eventId !== "string" || !event.eventId) throw badResponse(path, "an event has no eventId")
    if (typeof event.seq !== "number" || !Number.isSafeInteger(event.seq) || event.seq < 1) {
      throw badResponse(path, "an event has no positive integer seq")
    }
    if (typeof event.action !== "string" || !event.action) throw badResponse(path, "an event has no action")
    if (event.workspaceId !== null && typeof event.workspaceId !== "string") {
      throw badResponse(path, "an event's workspaceId is neither a string nor null")
    }
    if (typeof event.occurredAt !== "string") throw badResponse(path, "an event has no occurredAt")
    checkSnapshot(path, event.target, "an event's target")
    checkSnapshot(path, event.before, "an event's before")
    checkSnapshot(path, event.after, "an event's after")
    return event as unknown as WorkspaceChangeEvent
  }

  function checkWorkspace(path: string, value: unknown, what: string): Json {
    const workspace = checkRecord(path, value, what)
    if (typeof workspace.workspaceId !== "string") throw badResponse(path, `${what} has no workspaceId`)
    return workspace
  }

  /** Every hold on a workspace, as `PUT` and `DELETE` on a deletion hold answer it. */
  function checkHolds(path: string, value: unknown): DeletionHoldsResponse {
    const raw = checkRecord(path, value, "the deletion holds")
    if (typeof raw.workspaceId !== "string") throw badResponse(path, "the deletion holds have no workspaceId")
    if (!Array.isArray(raw.holds) || !raw.holds.every(isWorkspaceDeletionHold)) {
      throw badResponse(path, "holds is not a list of deletion holds")
    }
    // Fail closed on a Core that does not say: one that predates `asOf` would apply a late call.
    if (typeof raw.ignored !== "boolean") throw badResponse(path, "ignored is not a boolean")
    return {workspaceId: raw.workspaceId, holds: raw.holds, ignored: raw.ignored}
  }

  /** Sends one signed request. Resolves to the parsed JSON body, or null when `nullOn` accepts the failure. */
  async function call(
    method: "GET" | "POST" | "PUT" | "DELETE",
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
    if (payload !== undefined) headers["content-type"] = "application/json"

    let status: number
    let text: string
    try {
      const response = await doFetch(`${baseUrl}${pathWithQuery}`, {
        method,
        headers,
        body: payload === undefined ? undefined : body,
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

    async listChanges(input) {
      const query = new URLSearchParams()
      if (input.after !== undefined && input.after !== null) query.set("after", input.after)
      if (input.limit !== undefined) query.set("limit", String(input.limit))
      const queryString = query.toString()
      const path = `${API_PREFIX}/changes${queryString ? `?${queryString}` : ""}`
      const raw = checkRecord(path, await call("GET", path), "the change page")
      if (!Array.isArray(raw.events)) throw badResponse(path, "missing events")
      if (raw.next !== null && (typeof raw.next !== "string" || !CURSOR.test(raw.next))) {
        throw badResponse(path, "next is neither a sequence number nor null")
      }
      let previous = 0
      for (const event of raw.events) {
        const checked = checkChangeEvent(path, event)
        if (checked.seq <= previous) throw badResponse(path, "events are not in strictly increasing seq order")
        previous = checked.seq
      }
      // The cursor a poller stores is the last event's seq: one that points anywhere else skips or repeats events.
      const last = raw.events[raw.events.length - 1] as WorkspaceChangeEvent | undefined
      if (raw.next !== null && String(last?.seq) !== raw.next) {
        throw badResponse(path, "next is not the seq of the last event")
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

    async resolveEmail(email) {
      const path = `${API_PREFIX}/users/resolve-email`
      const raw = await call("POST", path, {email}, (status, error) => status === 404 && error === USER_NOT_FOUND_ERROR)
      if (raw === null) return null
      if (!isRecord(raw) || typeof raw.mentraUserId !== "string" || !raw.mentraUserId) {
        throw badResponse(path, "missing mentraUserId")
      }
      return raw.mentraUserId
    },

    async setDeletionHold(workspaceId, hold) {
      const path = deletionHoldPath(workspaceId)
      const asOf = hold.asOf.toISOString()
      // Only what was given: an absent count is "no count", never a null Core would have to read.
      const body = hold.count === undefined ? {reason: hold.reason, asOf} : {reason: hold.reason, count: hold.count, asOf}
      return checkHolds(path, await call("PUT", path, body))
    },

    async clearDeletionHold(workspaceId, update) {
      const path = deletionHoldPath(workspaceId)
      const body: DeletionHoldUpdate = {asOf: update.asOf.toISOString()}
      return checkHolds(path, await call("DELETE", path, body))
    },
  }

  /** This service's own hold on a workspace: the service in the path is always the one that signs. */
  function deletionHoldPath(workspaceId: string): string {
    return `${API_PREFIX}/workspaces/${encodeURIComponent(workspaceId)}/deletion-holds/${encodeURIComponent(opts.service)}`
  }
}
