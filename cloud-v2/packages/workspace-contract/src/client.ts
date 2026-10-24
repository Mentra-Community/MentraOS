/**
 * Signed client for Core's internal service API (`/api/internal/workspaces/*`, the Store's
 * `/api/internal/licenses/*`, and the miniapp registry's `/api/internal/registry/*`), for a service that shares a
 * secret with its Core (the Store, Fleet). Every request is signed over its timestamp, method, path and body hash
 * (`service-signature.ts`); no request names an organization.
 */
import {WORKSPACE_ROLES} from "./capabilities"
import {isWorkspaceDeletionHold} from "./deletion-holds"
import {OWNER_NOT_FOUND_ERROR, STALE_REVISION_ERROR} from "./licenses"
import type {LicensesResponse, LicenseView, LicenseWrite, LicenseWriteResponse} from "./licenses"
import {SERVICE_HEADERS, signServiceRequest} from "./service-signature"
import {
  INVALID_TOKEN_ERROR,
  REGISTRY_CHECK_STATUSES,
  REGISTRY_ENTRY_NOT_FOUND_ERROR,
  SERVICE_UNAUTHORIZED_ERROR,
  USER_NOT_FOUND_ERROR,
  WORKSPACE_NOT_FOUND_ERROR,
} from "./types"
import type {
  AuthorizeRequest,
  AuthorizeResponse,
  DeletionHoldsResponse,
  DeletionHoldUpdate,
  MembershipCheckEntry,
  MembershipInterval,
  MembershipIntervalsResponse,
  PrincipalResponse,
  RegistryArchiveRequest,
  RegistryArchiveResponse,
  RegistryArchiveRuleKind,
  RegistryCheckRequest,
  RegistryCheckResult,
  RegistryEntryDetail,
  RegistryLookupEntry,
  RegistryLookupRequest,
  WorkspaceChangeEvent,
  WorkspaceChangesResponse,
  WorkspaceMembersResponse,
  WorkspaceSummary,
} from "./types"

const API_PREFIX = "/api/internal/workspaces"
const LICENSES_PREFIX = "/api/internal/licenses"
const REGISTRY_PREFIX = "/api/internal/registry"
const REGISTRY_RULE_KINDS: readonly RegistryArchiveRuleKind[] = ["url", "package", "domain", "account"]
const AGE_RATINGS = ["4+", "9+", "13+", "16+", "18+"]
/** A feed cursor: a `seq` as a decimal string, with no sign, leading zero or fraction. */
const CURSOR = /^[1-9]\d*$/
const DEFAULT_TIMEOUT_MS = 5_000
/**
 * The least time a registry check gets: Core answers it within 10 seconds (`REGISTRY_CHECK_DEADLINE_MS` in Core),
 * so the client waits that long and a little more for the answer to arrive, whatever its own timeout.
 */
export const REGISTRY_CHECK_TIMEOUT_MS = 15_000

export type CoreWorkspaceClientErrorCode =
  /** Core could not be reached, timed out, or answered with a 5xx. */
  | "core_unavailable"
  /** Core rejected this service's signature or secret (HTTP 401 `service_unauthorized`). */
  | "service_unauthorized"
  /** Core answered 401 for another reason. */
  | "unauthorized"
  /** This service is not allowed to call the endpoint (HTTP 403). */
  | "forbidden"
  /** A license write older than the one Core has (HTTP 409 `stale_revision`): Core has the newer one. */
  | "stale_revision"
  /** A license write for an owner that is deleted or never existed (HTTP 404 `owner_not_found`): retrying cannot help. */
  | "owner_not_found"
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
  /**
   * One page of membership interval history (Fleet only). Every interval overlapping the lookback window is
   * returned, including an open one that started before it. `after` is the previous page's opaque `next`
   * (omitted or null starts from the beginning); `limit` is at most 500. The response's `feedSeq` is the change-feed
   * position the read is consistent with, so a consumer then applies feed events after it.
   */
  listMembershipIntervals(input: {after?: string | null; limit?: number}): Promise<MembershipIntervalsResponse>
  /** Who is in a workspace now, with names (Fleet only). An unknown or deleted workspace is `workspace_not_found`. */
  listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMembersResponse>
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
  /**
   * Write a license as billing last computed it (the Store only). Core applies it when `revision` is newer
   * than the one it has (`applied: true`) and answers a repeat of the revision it has with `applied:
   * false`. An older revision throws `stale_revision` (409): Core already has a newer one, so the write
   * counts as delivered. A workspace that is deleted or never existed throws `owner_not_found` (404): stop
   * sending it. A Core that cannot answer throws `core_unavailable` (5xx, or no answer): send it again.
   * Any other refusal is a malformed write (`bad_request`).
   */
  putLicense(write: LicenseWrite): Promise<LicenseWriteResponse>
  /** One workspace's licenses, ended ones included, each with how many seats are assigned (the Store only). */
  listLicenses(workspaceId: string): Promise<LicensesResponse>
  /**
   * What the miniapp registry says of each URL an admin is assigning (Fleet only): one result per URL, in order.
   * Core registers a URL it doesn't know as the admin's own install would, answering a sign-in challenge with a
   * token that names `workspaceId`, and gives up on a URL it hasn't finished within 10 seconds (`unknown`), so this
   * call waits at least `REGISTRY_CHECK_TIMEOUT_MS` whatever the client's `timeoutMs`. A person
   * who isn't an active member of the workspace is `forbidden` (`403 not_a_member`).
   */
  checkRegistry(input: RegistryCheckRequest): Promise<RegistryCheckResult[]>
  /**
   * Names for a workspace's views (Fleet only): every package asked about, null where the registry has none. A
   * private miniapp is named only for a workspace that assigned it.
   */
  lookupRegistry(input: RegistryLookupRequest): Promise<Record<string, RegistryLookupEntry | null>>
  /**
   * The registry's entry for a miniapp URL and Core's verified `miniapp.json` (the Store only), or null when the
   * registry has none (`404 not_found`). Core shows a private or phone-reported entry's URL and package only.
   */
  getRegistryEntry(url: string): Promise<RegistryEntryDetail | null>
  /**
   * Archive a URL, a package name, a registrable domain or an account's entries (the Store only), for the staff
   * member `actorEmail`. Archiving a rule that exists changes nothing (`created: false`). A rule that can't name any
   * entry is `bad_request`.
   */
  archiveRegistry(input: RegistryArchiveRequest): Promise<RegistryArchiveResponse>
}

export interface CoreWorkspaceClientOptions {
  /** Core's origin, e.g. `https://core.example.com`. Signed paths start at `/api/internal/`. */
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

  const INTERVAL_END_REASONS = ["left", "removed", "workspace_deleted", "account_deleted"]

  /** An interval as Core lists it: a closed one names why it ended, an open one does not. */
  function checkInterval(path: string, value: unknown): MembershipInterval {
    const interval = checkRecord(path, value, "an interval")
    for (const field of ["membershipId", "workspaceId", "mentraUserId", "role"] as const) {
      if (typeof interval[field] !== "string" || !interval[field]) throw badResponse(path, `an interval has no ${field}`)
    }
    if (typeof interval.start !== "string" || Number.isNaN(Date.parse(interval.start))) {
      throw badResponse(path, "an interval's start is not a time")
    }
    if (interval.end === null) {
      if (interval.endReason !== null) throw badResponse(path, "an open interval names an endReason")
    } else {
      if (typeof interval.end !== "string" || Number.isNaN(Date.parse(interval.end))) {
        throw badResponse(path, "an interval's end is neither a time nor null")
      }
      if (Date.parse(interval.end) < Date.parse(interval.start)) throw badResponse(path, "an interval ends before it starts")
      if (typeof interval.endReason !== "string" || !INTERVAL_END_REASONS.includes(interval.endReason)) {
        throw badResponse(path, "a closed interval has no known endReason")
      }
    }
    checkRoleIntervals(path, interval)
    return interval as unknown as MembershipInterval
  }

  /** An interval's role intervals: at least one, in order, inside the interval, only the last one open. */
  function checkRoleIntervals(path: string, interval: Json): void {
    const roles = interval.roles
    if (!Array.isArray(roles) || roles.length === 0) throw badResponse(path, "an interval has no role intervals")
    const start = Date.parse(interval.start as string)
    const end = interval.end === null ? null : Date.parse(interval.end as string)
    let previousEnd = start
    roles.forEach((value, index) => {
      const entry = checkRecord(path, value, "a role interval")
      if (typeof entry.role !== "string" || !(WORKSPACE_ROLES as readonly string[]).includes(entry.role)) {
        throw badResponse(path, "a role interval has no known role")
      }
      const from = typeof entry.start === "string" ? Date.parse(entry.start) : NaN
      if (Number.isNaN(from) || from < previousEnd) throw badResponse(path, "a role interval starts out of order")
      const last = index === roles.length - 1
      if (entry.end === null) {
        if (!last || end !== null) throw badResponse(path, "only the last role of an open interval is open")
        return
      }
      const to = typeof entry.end === "string" ? Date.parse(entry.end) : NaN
      if (Number.isNaN(to) || to < from || (end !== null && to > end)) throw badResponse(path, "a role interval's end is out of range")
      if (last && end === null) throw badResponse(path, "the last role of an open interval is still held")
      previousEnd = to
    })
  }

  function checkWorkspace(path: string, value: unknown, what: string): Json {
    const workspace = checkRecord(path, value, what)
    if (typeof workspace.workspaceId !== "string") throw badResponse(path, `${what} has no workspaceId`)
    return workspace
  }

  /** A license as Core lists it: the fields a caller relies on, each of its type. */
  function checkLicense(path: string, value: unknown): LicenseView {
    const license = checkRecord(path, value, "a license")
    if (typeof license.licenseId !== "string" || !license.licenseId) throw badResponse(path, "a license has no licenseId")
    if (!isRecord(license.owner) || typeof license.owner.type !== "string") throw badResponse(path, "a license has no owner")
    for (const field of ["revision", "quantity", "seatsUsed"] as const) {
      if (typeof license[field] !== "number" || !Number.isSafeInteger(license[field])) {
        throw badResponse(path, `a license's ${field} is not a whole number`)
      }
    }
    if (typeof license.product !== "string" || !Array.isArray(license.features)) {
      throw badResponse(path, "a license has no product or features")
    }
    if (typeof license.validFrom !== "string" || typeof license.paidThrough !== "string") {
      throw badResponse(path, "a license has no term")
    }
    if (license.endedAt !== null && typeof license.endedAt !== "string") {
      throw badResponse(path, "a license's endedAt is neither a time nor null")
    }
    return license as unknown as LicenseView
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

  const isTextOrNull = (value: unknown) => value === null || typeof value === "string"
  const isTime = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value))

  /** A check result for `url`, the URL asked about in its place. */
  function checkCheckResult(path: string, value: unknown, url: string): RegistryCheckResult {
    const result = checkRecord(path, value, "a check result")
    if (result.url !== url) throw badResponse(path, "the results are not the URLs asked about, in order")
    if (typeof result.status !== "string" || !(REGISTRY_CHECK_STATUSES as readonly string[]).includes(result.status)) {
      throw badResponse(path, "a check result has no known status")
    }
    for (const field of ["packageName", "name", "iconUrl"] as const) {
      if (!isTextOrNull(result[field])) throw badResponse(path, `a check result's ${field} is not text or null`)
    }
    if (typeof result.private !== "boolean") throw badResponse(path, "a check result's private is not a boolean")
    if (!isTime(result.checkedAt)) throw badResponse(path, "a check result's checkedAt is not a time")
    return {
      url,
      status: result.status as RegistryCheckResult["status"],
      packageName: result.packageName as string | null,
      name: result.name as string | null,
      iconUrl: result.iconUrl as string | null,
      private: result.private,
      checkedAt: result.checkedAt as string,
    }
  }

  function checkLookupEntry(path: string, value: unknown): RegistryLookupEntry | null {
    if (value === null) return null
    const entry = checkRecord(path, value, "a lookup entry")
    if (!isTextOrNull(entry.name) || !isTextOrNull(entry.iconUrl)) {
      throw badResponse(path, "a lookup entry's name or iconUrl is not text or null")
    }
    if (typeof entry.private !== "boolean" || typeof entry.archived !== "boolean") {
      throw badResponse(path, "a lookup entry's private or archived is not a boolean")
    }
    return {
      name: entry.name as string | null,
      iconUrl: entry.iconUrl as string | null,
      private: entry.private,
      archived: entry.archived,
    }
  }

  /** A registry entry as `entries` answers it: the view's fields, each of its type, and the manifest or null. */
  function checkRegistryEntry(path: string, value: unknown): RegistryEntryDetail {
    const entry = checkRecord(path, value, "the registry entry")
    for (const field of ["url", "packageName", "registrableDomain"] as const) {
      if (typeof entry[field] !== "string" || !entry[field]) throw badResponse(path, `the registry entry has no ${field}`)
    }
    for (const field of ["name", "version", "iconUrl"] as const) {
      if (!isTextOrNull(entry[field])) throw badResponse(path, `the registry entry's ${field} is not text or null`)
    }
    if (entry.ageRating !== null && !AGE_RATINGS.includes(entry.ageRating as string)) {
      throw badResponse(path, "the registry entry's ageRating is not a rating or null")
    }
    if (entry.verification !== "verified" && entry.verification !== "phone_reported") {
      throw badResponse(path, "the registry entry has no known verification")
    }
    if (entry.status !== "active" && entry.status !== "archived") throw badResponse(path, "the registry entry has no known status")
    if (typeof entry.private !== "boolean") throw badResponse(path, "the registry entry's private is not a boolean")
    if (!isTime(entry.firstRegisteredAt)) throw badResponse(path, "the registry entry's firstRegisteredAt is not a time")
    if (entry.lastVerifiedAt !== null && !isTime(entry.lastVerifiedAt)) {
      throw badResponse(path, "the registry entry's lastVerifiedAt is neither a time nor null")
    }
    if (entry.manifest !== null) {
      const manifest = checkRecord(path, entry.manifest, "the registry entry's manifest")
      for (const field of ["packageName", "version", "name"] as const) {
        if (typeof manifest[field] !== "string") throw badResponse(path, `the manifest has no ${field}`)
      }
      if (!isRecord(manifest.bundle) || typeof manifest.bundle.url !== "string" || typeof manifest.bundle.sha256 !== "string") {
        throw badResponse(path, "the manifest has no bundle")
      }
    }
    return entry as unknown as RegistryEntryDetail
  }

  /** Sends one signed request. Resolves to the parsed JSON body, or null when `nullOn` accepts the failure. */
  async function call(
    method: "GET" | "POST" | "PUT" | "DELETE",
    pathWithQuery: string,
    payload?: unknown,
    nullOn?: (status: number, error: string | undefined) => boolean,
    callTimeoutMs: number = timeoutMs,
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
        signal: AbortSignal.timeout(callTimeoutMs),
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
    // Only Core's own codes say something about the license; a bare 404 or 409 from anything else does not.
    if (status === 409 && error === STALE_REVISION_ERROR) return new CoreWorkspaceClientError("stale_revision", message, status)
    if (status === 404 && error === OWNER_NOT_FOUND_ERROR) return new CoreWorkspaceClientError("owner_not_found", message, status)
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

    async listWorkspaceMembers(workspaceId) {
      const path = `${API_PREFIX}/workspaces/${encodeURIComponent(workspaceId)}/members`
      const raw = checkRecord(path, await call("GET", path), "the member list")
      if (!Array.isArray(raw.members)) throw badResponse(path, "missing members")
      for (const entry of raw.members) {
        const member = checkRecord(path, entry, "a member")
        if (typeof member.membershipId !== "string" || !member.membershipId) throw badResponse(path, "a member has no membershipId")
        if (typeof member.role !== "string" || !member.role) throw badResponse(path, "a member has no role")
        for (const field of ["mentraUserId", "email"] as const) {
          if (member[field] !== null && typeof member[field] !== "string") throw badResponse(path, `a member's ${field} is not text or null`)
        }
        if (member.name !== undefined && member.name !== null && typeof member.name !== "string") {
          throw badResponse(path, "a member's name is not text or null")
        }
      }
      return {members: raw.members as WorkspaceMembersResponse["members"]}
    },

    async listMembershipIntervals(input) {
      const query = new URLSearchParams()
      if (input.after !== undefined && input.after !== null) query.set("after", input.after)
      if (input.limit !== undefined) query.set("limit", String(input.limit))
      const queryString = query.toString()
      const path = `${API_PREFIX}/membership-intervals${queryString ? `?${queryString}` : ""}`
      const raw = checkRecord(path, await call("GET", path), "the interval page")
      if (typeof raw.lookbackDays !== "number" || !Number.isSafeInteger(raw.lookbackDays) || raw.lookbackDays < 1) {
        throw badResponse(path, "lookbackDays is not a positive whole number")
      }
      if (typeof raw.windowStart !== "string" || Number.isNaN(Date.parse(raw.windowStart))) {
        throw badResponse(path, "windowStart is not a time")
      }
      if (typeof raw.feedSeq !== "number" || !Number.isSafeInteger(raw.feedSeq) || raw.feedSeq < 0) {
        throw badResponse(path, "feedSeq is not a whole number")
      }
      if (!Array.isArray(raw.intervals)) throw badResponse(path, "missing intervals")
      if (raw.next !== null && (typeof raw.next !== "string" || raw.next.length === 0)) {
        throw badResponse(path, "next is neither a cursor nor null")
      }
      const intervals = raw.intervals.map(value => checkInterval(path, value))
      return {
        lookbackDays: raw.lookbackDays,
        windowStart: raw.windowStart,
        feedSeq: raw.feedSeq,
        intervals,
        next: raw.next,
      }
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

    async putLicense(write) {
      const path = `${LICENSES_PREFIX}/${encodeURIComponent(write.licenseId)}`
      const raw = checkRecord(path, await call("PUT", path, write), "the license write")
      if (typeof raw.applied !== "boolean" || typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision)) {
        throw badResponse(path, "missing applied or a whole revision")
      }
      return {applied: raw.applied, revision: raw.revision}
    },

    async listLicenses(workspaceId) {
      const query = new URLSearchParams({ownerType: "workspace", ownerId: workspaceId})
      const path = `${LICENSES_PREFIX}?${query.toString()}`
      const raw = checkRecord(path, await call("GET", path), "the license list")
      if (!Array.isArray(raw.licenses)) throw badResponse(path, "licenses is not a list")
      return {licenses: raw.licenses.map(license => checkLicense(path, license))}
    },

    async checkRegistry(input) {
      const path = `${REGISTRY_PREFIX}/check`
      const body: RegistryCheckRequest = {urls: input.urls, workspaceId: input.workspaceId, mentraUserId: input.mentraUserId}
      // Core takes up to 10 seconds to answer a check, longer than the client's usual timeout.
      const answer = await call("POST", path, body, undefined, Math.max(timeoutMs, REGISTRY_CHECK_TIMEOUT_MS))
      const raw = checkRecord(path, answer, "the check")
      if (!Array.isArray(raw.results) || raw.results.length !== input.urls.length) {
        throw badResponse(path, "results is not one result per URL")
      }
      return raw.results.map((result, index) => checkCheckResult(path, result, input.urls[index]!))
    },

    async lookupRegistry(input) {
      const path = `${REGISTRY_PREFIX}/lookup`
      const body: RegistryLookupRequest = {workspaceId: input.workspaceId, packageNames: input.packageNames}
      const raw = checkRecord(path, await call("POST", path, body), "the lookup")
      const entries = checkRecord(path, raw.entries, "the lookup's entries")
      // Built from the names asked about, so a name such as `__proto__` is an own entry like any other.
      return Object.fromEntries(
        input.packageNames.map(packageName => {
          if (!Object.prototype.hasOwnProperty.call(entries, packageName)) {
            throw badResponse(path, "the lookup leaves out a package asked about")
          }
          return [packageName, checkLookupEntry(path, entries[packageName])]
        }),
      )
    },

    async getRegistryEntry(url) {
      const path = `${REGISTRY_PREFIX}/entries?${new URLSearchParams({url}).toString()}`
      const raw = await call(
        "GET",
        path,
        undefined,
        (status, error) => status === 404 && error === REGISTRY_ENTRY_NOT_FOUND_ERROR,
      )
      if (raw === null) return null
      return checkRegistryEntry(path, checkRecord(path, raw, "the entry response").entry)
    },

    async archiveRegistry(input) {
      const path = `${REGISTRY_PREFIX}/archive`
      const body: RegistryArchiveRequest = {rule: input.rule, reason: input.reason, actorEmail: input.actorEmail}
      const raw = checkRecord(path, await call("POST", path, body), "the archive answer")
      const rule = checkRecord(path, raw.rule, "the archive rule")
      if (!REGISTRY_RULE_KINDS.includes(rule.kind as RegistryArchiveRuleKind) || typeof rule.value !== "string") {
        throw badResponse(path, "the archive rule has no known kind or value")
      }
      if (typeof raw.created !== "boolean") throw badResponse(path, "created is not a boolean")
      if (typeof raw.entriesArchived !== "number" || !Number.isSafeInteger(raw.entriesArchived) || raw.entriesArchived < 0) {
        throw badResponse(path, "entriesArchived is not a whole number")
      }
      return {
        rule: {kind: rule.kind as RegistryArchiveRuleKind, value: rule.value},
        created: raw.created,
        entriesArchived: raw.entriesArchived,
      }
    },
  }

  /** This service's own hold on a workspace: the service in the path is always the one that signs. */
  function deletionHoldPath(workspaceId: string): string {
    return `${API_PREFIX}/workspaces/${encodeURIComponent(workspaceId)}/deletion-holds/${encodeURIComponent(opts.service)}`
  }
}
