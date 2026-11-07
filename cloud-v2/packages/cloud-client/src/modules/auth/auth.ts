/**
 * @fileoverview `cloud.auth`: the one owner of credentials.
 *
 * It owns the credential lifecycle for the configured services. Core tokens are
 * exchanged/refreshed through Cloud Core. Runtime tokens are either supplied by
 * the host/OEM or explicitly minted by Core's `/runtime-token` broker endpoint.
 *
 * Token lifecycle:
 *  - First use exchanges the configured subject token at `/exchange` for an
 *    access + refresh pair (RFC 8693). A `getSubjectToken` callback variant
 *    fetches the subject token on demand for subject tokens that themselves
 *    expire. An `accessToken`/`refreshToken` variant skips straight to refresh.
 *  - Near expiry (within a 60s margin) it refreshes at `/refresh` and rotates.
 *  - Exchange and refresh are single-flighted, so a reconnect storm cannot fire
 *    a burst of competing requests (and a rotated refresh token cannot be
 *    invalidated out from under a concurrent caller). Miniapp mints run one at
 *    a time per package and are shared as `getMiniappToken` describes.
 *  - If Core definitively rejects the refresh token (see
 *    `DEAD_REFRESH_TOKEN_ERRORS`) and the host can fetch a fresh subject token
 *    on demand, we clear the dead refresh token and exchange once. If no fresh
 *    subject is available (or exchange also fails), `onExpired` fires once and
 *    the host re-authenticates. We do not retry forever against a dead refresh
 *    token.
 *  - Any other refresh failure (network error, timeout, 408, 429, 5xx, an answer
 *    that is not Core's) says nothing about the token. It is kept, `onExpired`
 *    does not fire, no exchange is attempted, and `AuthUnavailableError` is
 *    thrown so the caller retries later with the same refresh token.
 *  - Exchange failures are classified the same way: only Core's own refusal of
 *    the subject token (`EXCHANGE_REFUSAL_ERRORS`) is an `AuthExpiredError`, and
 *    `onExpired` fires only when that refusal answers the fresh exchange that
 *    follows a rejected refresh token. Anything else, including the host's
 *    `getSubjectToken` throwing, is an `AuthUnavailableError` and notifies no one.
 *  - A rejection or exchange answer that arrives after `clearSession()` is about
 *    a session that is gone: it notifies no one and restores nothing.
 *
 * Security: the access token is never written to storage, never given to a
 * miniapp, and no token is ever logged.
 *
 * See docs/issues/004-cloud-client/spec.md ("cloud.auth"), design.md, and
 * docs/issues/001-cloud-core/auth/spec.md (endpoints + token shapes).
 */
import type {AuthConfig, CoreAuthConfig, RuntimeAuthConfig, SubjectTokenType} from "../../config"
import type {HttpClient} from "../../http"
import type {Logger} from "../../logger"
import type {HttpTransport} from "../../transports"
import {AuthExpiredError, AuthUnavailableError, HttpError, SessionRevocationError} from "../../errors"
import {systemTimers, type CloudClientTimers} from "../../timers"
import {decodeClaims} from "./jwt"
import {TokenStore} from "./token-store"

/**
 * The public auth surface a host uses, from spec.md.
 *
 * Declared here (rather than imported) because it is a client-side module
 * contract, not a wire type: the protocol package owns the on-the-wire shapes,
 * this owns the module shapes. `cloud.runtime` and `cloud.core` depend only on
 * `getRuntimeToken` / `getCoreToken`.
 */
export interface AuthModule {
  // current runtime token, refreshing as needed. Pass
  // `{ forceRefresh: true }` to bypass the in-memory cache and refresh now, for
  // the case where the cloud rejected a token the client still thinks is fresh
  // (clock skew or a mid-session revoke surfaced as AUTH_EXPIRED).
  getRuntimeToken(opts?: {forceRefresh?: boolean}): Promise<string>
  // current Core token, refreshing as needed (Core-backed mode only).
  getCoreToken(opts?: {forceRefresh?: boolean}): Promise<string>
  // a miniapp-scoped token, cached per packageName and re-minted before expiry.
  // Pass `{ fresh: true }` to skip the cache and mint now, for the moments the
  // token's claims must be current (a miniapp opening). Pass
  // `{ localBuild: true }` for a local or development build: Core marks its
  // token as one, and it is cached apart from the installed miniapp's.
  getMiniappToken(
    packageName: string,
    opts?: {minTtlMs?: number; fresh?: boolean; localBuild?: boolean},
  ): Promise<{token: string; expiresAt: number}>
  // Core-owned user/oem identity, read from the Core access token.
  // Runtime-only deployments do not expose this surface.
  readonly identity: {mentraUserId: string; tenantId: string}
  // clear access, refresh, runtime, and miniapp credentials for logout. Local
  // credentials are always cleared; rejects with `SessionRevocationError` when
  // Core did not confirm revocation of the server-side session.
  clearSession(): Promise<void>
  // Core rejected the refresh token; the host must send the user back through login
  onExpired(handler: () => void): () => void
}

/** RFC 8693 token-exchange grant type for the `/exchange` call. */
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange"

/**
 * Map a config `SubjectTokenType` to the RFC 8693 `subject_token_type` URN the
 * cloud expects.
 *
 * All supported subject tokens (OIDC, an OEM-signed JWT, a Mentra core token,
 * or a Supabase session) are presented as a JWT and verified by their own `iss` /
 * verification path on the cloud, so they share the one JWT token-type URN. The
 * mapping is kept explicit (rather than hard-coding one URN) so that if the
 * cloud later wants distinct URNs per source, this is the single place to widen.
 */
const SUBJECT_TOKEN_TYPE_URN: Record<SubjectTokenType, string> = {
  "oidc": "urn:ietf:params:oauth:token-type:jwt",
  "oem-jwt": "urn:ietf:params:oauth:token-type:jwt",
  "mentra-core": "urn:ietf:params:oauth:token-type:jwt",
  "supabase": "urn:ietf:params:oauth:token-type:jwt",
}

/** Seconds of headroom before `exp` at which we proactively refresh/re-mint. */
const EXPIRY_MARGIN_SECONDS = 60

/** Total attempts at the idempotent `/revoke` during logout on network/5xx failures. */
const REVOKE_ATTEMPTS = 3
/** Base backoff between revoke attempts in milliseconds; doubles per attempt. */
const REVOKE_RETRY_BASE_MS = 250
/** Whole remote logout operation, including refresh and retries. */
const REVOKE_TIMEOUT_MS = 10_000

/** The cloud's token endpoints, relative to the core base URL. */
const EXCHANGE_PATH = "/api/client/auth/exchange"
const REFRESH_PATH = "/api/client/auth/refresh"
const RUNTIME_TOKEN_PATH = "/api/client/auth/runtime-token"
const MINIAPP_TOKEN_PATH = "/api/client/auth/miniapp-token"
const REVOKE_PATH = "/api/client/auth/revoke"

/** Single-flight keys. The miniapp key is suffixed per packageName below. */
const FLIGHT_ACCESS = "access-token"
const FLIGHT_RUNTIME = "runtime-token"
const MINIAPP_FLIGHT_PREFIX = "miniapp-token:"

/** The cloud's RFC-shaped token response from `/exchange` and `/refresh`. */
interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
}

/** A cached miniapp token plus its absolute expiry (Unix seconds). */
interface MiniappTokenEntry {
  token: string
  expiresAt: number
}

/**
 * One miniapp mint. `requestSent()` turns true just before the request to Core
 * leaves. Until then a caller who needs a token minted from now on can still
 * share it, because Core has not yet read anything on its behalf.
 */
interface MiniappMint {
  promise: Promise<MiniappTokenEntry>
  requestSent: () => boolean
}

interface RuntimeTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
}

interface RuntimeTokenEntry {
  token: string
  expiresAt: number
}

/**
 * The cache key of a package's miniapp token: an installed miniapp's and a local
 * build's are different tokens. The variant comes first and holds no `:`, so no
 * package name makes one key look like another.
 */
function miniappTokenKey(packageName: string, localBuild: boolean): string {
  return `${localBuild ? "local" : "installed"}:${packageName}`
}

/**
 * A revoke is worth retrying only when Core gave no definite answer: the
 * transport failed (`status` 0) or the server errored (5xx). A 4xx means Core
 * rejected the request and repeating it would not change the outcome.
 */
function isRetryableRevokeError(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 0 || err.status >= 500)
}

/**
 * What counts as Core itself refusing a token request, as opposed to a request
 * that merely failed. Core renders every refusal as `{error, error_description}`
 * through its global error translator (`api/app.ts`) with the status its
 * `OauthError` carries (`types/oauth.types.ts`). Only a 400 or 401 whose body has
 * one of the codes below counts; RFC 6749 lets a server pick between the two
 * statuses, so both are accepted for every code. A 5xx, 408 or 429, a body that
 * is not JSON, or any other 4xx is not Core talking about the credentials at all
 * (a proxy, a captive portal, an outage), so it is never a refusal.
 */
const CORE_REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 401])

/**
 * The only answers to `POST /api/client/auth/refresh` that say the refresh token
 * (or the session it belongs to) is gone for good. `refreshSession`
 * (`services/session.service.ts`) refuses a token for exactly two reasons:
 *
 *  - `invalid_grant`, HTTP 400: the token is unknown, expired or already used,
 *    its session identity is incomplete, or its account is deleted.
 *  - `unauthorized_client`, HTTP 401: the session's tenant (OEM or enterprise
 *    org) is unknown or disabled.
 *
 * `invalid_request` and `unsupported_grant_type` describe the shape of the
 * request (a missing `refresh_token` or `grant_type`), which a proxy that drops
 * or rewrites the form body produces just as well, so they are no verdict on the
 * token.
 */
const DEAD_REFRESH_TOKEN_ERRORS: ReadonlySet<string> = new Set(["invalid_grant", "unauthorized_client"])

/**
 * The answers to `POST /api/client/auth/exchange` that say the subject token is
 * unusable (`oem.service.ts`, `session.service.ts`): `invalid_grant` (it failed
 * verification or lacks required claims), `unauthorized_client` (its OEM is
 * unknown or disabled), and `invalid_request` (it is not a parseable JWT).
 * `unsupported_grant_type` is left out for the same reason as on refresh.
 */
const EXCHANGE_REFUSAL_ERRORS: ReadonlySet<string> = new Set([
  "invalid_grant",
  "unauthorized_client",
  "invalid_request",
])

/** OAuth error codes are short snake_case words; anything else is not safe to keep or log. */
const OAUTH_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

/**
 * A token endpoint answered with a non-2xx status. `status` is the HTTP status and
 * `code` is the OAuth `error` from a JSON body, when there was a well-formed one.
 *
 * It is an `AuthExpiredError` so the logout refresh, which has always thrown that
 * for any non-2xx, is unchanged. `requestTokens` lets it out only when it is
 * Core's refusal (`isCoreRefusal`); every other non-2xx becomes an
 * `AuthUnavailableError` there.
 */
class TokenEndpointError extends AuthExpiredError {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
  }
}

/** Core definitively rejected the refresh token: it is cleared, and the host must re-authenticate. */
class RefreshTokenRejectedError extends AuthExpiredError {}

/** `err` is Core itself refusing the request: a 400 or 401 carrying one of `codes`. */
function isCoreRefusal(err: unknown, codes: ReadonlySet<string>): err is TokenEndpointError {
  return (
    err instanceof TokenEndpointError &&
    CORE_REFUSAL_STATUSES.has(err.status) &&
    err.code !== undefined &&
    codes.has(err.code)
  )
}

/** The caller or the transport cancelled the request. */
function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
}

export class Auth implements AuthModule {
  private readonly http?: HttpClient
  private readonly store: TokenStore
  private readonly coreConfig?: CoreAuthConfig
  private readonly runtimeConfig: RuntimeAuthConfig
  private readonly logger: Logger
  /**
   * Core base URL for the form-encoded `/exchange` and `/refresh` calls.
   *
   * These two endpoints take `application/x-www-form-urlencoded` bodies and
   * present the subject/refresh token in the body (not as a Bearer), so they do
   * not use the JSON-only `HttpClient`. They still use the host's injected HTTP
   * transport when one is available. In runtime-only mode this is absent by
   * design: Core identity, miniapp token minting, and miniapp auto-auth are
   * Core-backed features.
   */
  private readonly baseUrl?: string
  private readonly httpTransport: HttpTransport
  private readonly timers: CloudClientTimers

  /** Miniapp tokens cached per packageName and local-build flag (`miniappTokenKey`) until near expiry. */
  private readonly miniappCache = new Map<string, MiniappTokenEntry>()
  /** The newest mint per package, flag and session, until it settles. See `mintMiniappToken`. */
  private readonly miniappMints = new Map<string, MiniappMint>()
  /** Core-brokered runtime token cache. */
  private runtimeToken: RuntimeTokenEntry | null = null

  /** Registered `onExpired` handlers. */
  private readonly expiredHandlers = new Set<() => void>()

  /**
   * Latches once `onExpired` has fired, so a dead refresh token notifies the
   * host exactly once instead of on every subsequent call.
   */
  private expiredFired = false
  /** Incremented on logout so late async results cannot repopulate credentials. */
  private sessionGeneration = 0
  /** A logged-out client stays inert until the host constructs a fresh client. */
  private sessionCleared = false

  constructor(deps: {
    http?: HttpClient
    store: TokenStore
    config: AuthConfig
    logger: Logger
    baseUrl?: string
    fetch?: HttpTransport
    timers?: CloudClientTimers
  }) {
    this.http = deps.http
    this.store = deps.store
    this.coreConfig = deps.config.core
    this.runtimeConfig = deps.config.runtime
    this.logger = deps.logger
    this.baseUrl = deps.baseUrl
    this.httpTransport = deps.fetch ?? globalThis.fetch
    this.timers = deps.timers ?? systemTimers
  }

  /**
   * Return a currently valid access token, exchanging or refreshing as needed.
   *
   * The happy path is a cache hit: an in-memory token still outside the expiry
   * margin is returned with no network call. Otherwise we obtain one through a
   * single-flight so concurrent callers share the same request.
   */
  async getRuntimeToken(opts?: {forceRefresh?: boolean}): Promise<string> {
    this.assertSessionActive()
    if ("getToken" in this.runtimeConfig) {
      const generation = this.sessionGeneration
      const token = await this.runtimeConfig.getToken(opts)
      this.assertSessionActive(generation)
      return token
    }

    if (opts?.forceRefresh) {
      this.runtimeToken = null
    } else if (this.runtimeToken && !this.isExpiring(this.runtimeToken.expiresAt)) {
      return this.runtimeToken.token
    }

    const generation = this.sessionGeneration
    return this.store.singleFlight(`${FLIGHT_RUNTIME}:${generation}`, () =>
      this.obtainCoreBrokeredRuntimeToken(generation),
    )
  }

  async getCoreToken(opts?: {forceRefresh?: boolean}): Promise<string> {
    this.assertSessionActive()
    this.requireCoreConfig()
    // A forced refresh drops the cached access token first, so the cache check
    // below misses and we go straight to the single-flight refresh. The
    // single-flight still de-dupes, so a burst of forced refreshes (one per
    // reconnect attempt) collapses to one request.
    if (opts?.forceRefresh) {
      this.store.invalidateAccess()
    } else {
      const cached = this.store.current()
      if (cached && !this.isExpiring(cached.exp)) {
        return cached.accessToken
      }
    }

    // De-dupe: if a refresh/exchange is already running, await that one result.
    const generation = this.sessionGeneration
    return this.store.singleFlight(`${FLIGHT_ACCESS}:${generation}`, () => this.obtainAccessToken(generation))
  }

  /**
   * Mint (or return a cached) miniapp-scoped token for `packageName`.
   *
   * By default the token is cached per packageName and re-minted only when near
   * expiry, so a steady miniapp does not hit the cloud on every call.
   *
   * `localBuild: true` asks for a local or development build's token, which Core
   * marks as one (and never names a workspace in). It is a different token from
   * the installed miniapp's, so the two are cached and minted apart, and a call
   * never gets the other's.
   *
   * `fresh: true` skips the cache and reaches Core, because what Core puts in a
   * token (the features the user holds, today) can change within its hour. It
   * can share a mint only if that mint's request has not left yet; a mint whose
   * request is already out may have read the user's features before the change,
   * so the caller gets a new mint, which starts once the earlier one settles.
   * Callers waiting on that follow-up share it. `minTtlMs` has no use with
   * `fresh`: the token it returns was minted for this call.
   *
   * Mints for one package never overlap, and a default call that finds one in
   * flight takes it rather than starting another. The access token is the
   * Bearer here and is never exposed to the miniapp; only the returned
   * miniapp-scoped token is.
   */
  async getMiniappToken(
    packageName: string,
    opts?: {minTtlMs?: number; fresh?: boolean; localBuild?: boolean},
  ): Promise<{token: string; expiresAt: number}> {
    this.assertSessionActive()
    const generation = this.sessionGeneration
    const fresh = opts?.fresh === true
    const localBuild = opts?.localBuild === true
    if (!fresh) {
      const marginSeconds = this.tokenMarginSeconds(opts?.minTtlMs)
      const cached = this.miniappCache.get(miniappTokenKey(packageName, localBuild))
      if (cached && !this.isExpiring(cached.expiresAt, marginSeconds)) {
        return {token: cached.token, expiresAt: cached.expiresAt}
      }
    }

    const entry = await this.mintMiniappToken(packageName, localBuild, generation, fresh)
    return {token: entry.token, expiresAt: entry.expiresAt}
  }

  /**
   * The mint a caller should wait on. Mints for a package (and local-build flag)
   * form a chain, one at a time; `miniappMints` holds the newest link.
   *
   *  - A default caller takes the newest mint, whatever its state.
   *  - A fresh caller takes it only while its request is unsent. Otherwise it
   *    appends a mint that starts when the newest one settles, win or lose, and
   *    becomes the newest, so later fresh callers share it until it too sends.
   */
  private mintMiniappToken(
    packageName: string,
    localBuild: boolean,
    generation: number,
    fresh: boolean,
  ): Promise<MiniappTokenEntry> {
    const cacheKey = miniappTokenKey(packageName, localBuild)
    const key = `${MINIAPP_FLIGHT_PREFIX}${generation}:${cacheKey}`
    const newest = this.miniappMints.get(key)
    if (newest && (!fresh || !newest.requestSent())) return newest.promise

    let requestSent = false
    const promise = (async () => {
      if (newest) await newest.promise.catch(() => undefined)
      const accessToken = await this.getCoreToken()
      const http = this.requireCoreHttp()
      requestSent = true
      // The request names the package, and says when it is a local build so
      // Core marks the token. An installed miniapp's request names only the
      // package, as it always has.
      const body = localBuild ? {packageName, localBuild: true} : {packageName}
      const res = await http.post<MiniappTokenEntry>(MINIAPP_TOKEN_PATH, body, {bearer: accessToken})

      this.assertSessionActive(generation)
      const entry: MiniappTokenEntry = {token: res.token, expiresAt: res.expiresAt}
      this.miniappCache.set(cacheKey, entry)
      this.logger.debug("minted miniapp token", {packageName, localBuild})
      return entry
    })()
    const mint: MiniappMint = {promise, requestSent: () => requestSent}
    this.miniappMints.set(key, mint)
    // A later mint that replaced this one as the newest stays registered.
    const release = () => {
      if (this.miniappMints.get(key) === mint) this.miniappMints.delete(key)
    }
    void promise.then(release, release)
    return promise
  }

  /**
   * The user + OEM identity, read straight off the Core access token's claims.
   *
   * Core owns client identity. Runtime-only tokens may carry identity claims for
   * Runtime authorization/logging, but `cloud.auth.identity`, miniapp token
   * minting, and miniapp auto-auth are intentionally unavailable without
   * `auth.core` + `endpoints.core`.
   *
   * The claims are unverified base64 JSON (the cloud verifies the signature on
   * every call, so the client need not). Throws if no Core access token has been
   * obtained yet, since Core identity is meaningless before the first exchange.
   */
  get identity(): {mentraUserId: string; tenantId: string} {
    this.requireCoreConfig()
    const current = this.store.current()
    if (!current) {
      throw new AuthExpiredError("Core identity is unavailable before first Core sign-in")
    }
    const claims = decodeClaims(current.accessToken)
    return {mentraUserId: claims.sub, tenantId: claims.tenant_id}
  }

  async clearSession(): Promise<void> {
    const current = this.store.current()
    // Capture the saved refresh token before deleting it, but never reacquire
    // credentials through the upstream provider during logout.
    const refreshSnapshot = this.store.refreshToken()
    this.sessionGeneration += 1
    this.sessionCleared = true
    this.runtimeToken = null
    this.miniappCache.clear()
    this.expiredFired = false
    // Start local deletion in the same synchronous prefix as invalidation;
    // only local storage work may precede it, never a network operation.
    const localClear = this.store.clear()
    const [refreshToken] = await Promise.all([refreshSnapshot, localClear])
    const controller = new AbortController()
    let timeout: unknown
    try {
      await Promise.race([
        this.revokeCoreSession(current, refreshToken, controller.signal),
        new Promise<never>((_, reject) => {
          timeout = this.timers.setTimeout(() => {
            controller.abort()
            reject(new Error("Core session revocation timed out"))
          }, REVOKE_TIMEOUT_MS)
        }),
      ])
    } catch (error) {
      this.logger.warn("Core session revocation failed during local logout", {
        error: (error as Error)?.message,
      })
      throw new SessionRevocationError("Core session revocation failed; local credentials were cleared", {cause: error})
    } finally {
      this.timers.clearTimeout(timeout)
    }
  }

  /**
   * Revoke the captured Core session after local credentials are dropped.
   *
   * Core verifies the presented access token with no clock tolerance, so a
   * cached token inside the usual expiry margin is refreshed first rather than
   * risking a rejected revoke. `/revoke` is idempotent, so a network error or a
   * 5xx is retried a bounded number of times with backoff; a definite 4xx is
   * not. Any failure propagates so the caller can tell revocation did not
   * complete.
   */
  private async revokeCoreSession(
    current: ReturnType<TokenStore["current"]>,
    refreshToken: string | null,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.coreConfig || !this.http) return
    let accessToken: string | null = null
    if (current && !this.isExpiring(current.exp)) {
      accessToken = current.accessToken
    } else if (refreshToken) {
      const body = new URLSearchParams({grant_type: "refresh_token", refresh_token: refreshToken})
      const tokens = await this.postForm(REFRESH_PATH, body, "logout refresh", signal)
      accessToken = tokens.access_token
    }
    if (!accessToken) return

    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new Error("Core session revocation timed out")
      try {
        await this.http.post(REVOKE_PATH, {}, {bearer: accessToken, signal})
        return
      } catch (err) {
        if (attempt + 1 >= REVOKE_ATTEMPTS || !isRetryableRevokeError(err)) throw err
        this.logger.warn("Core session revocation failed; retrying", {attempt: attempt + 1})
        await new Promise<void>((resolve) => this.timers.setTimeout(resolve, REVOKE_RETRY_BASE_MS * 2 ** attempt))
      }
    }
  }

  /**
   * Register a handler invoked when a refresh fails and re-auth is required.
   *
   * Returns an unsubscribe function, matching the rest of the client's `on*`
   * surface. Handlers fire at most once per dead-credential event (see
   * `fireExpired`).
   */
  onExpired(handler: () => void): () => void {
    this.expiredHandlers.add(handler)
    return () => {
      this.expiredHandlers.delete(handler)
    }
  }

  // === internals ===

  /**
   * Decide whether a token is close enough to its `exp` that we should refresh
   * now rather than risk handing out one that expires mid-flight.
   *
   * `exp` is Unix seconds (the JWT convention), so we compare against the clock
   * in seconds and subtract the margin.
   */
  private isExpiring(expSeconds: number, marginSeconds = EXPIRY_MARGIN_SECONDS): boolean {
    const nowSeconds = Math.floor(Date.now() / 1000)
    return expSeconds - marginSeconds <= nowSeconds
  }

  private tokenMarginSeconds(minTtlMs?: number): number {
    if (!Number.isFinite(minTtlMs) || !minTtlMs || minTtlMs <= 0) {
      return EXPIRY_MARGIN_SECONDS
    }
    return Math.max(EXPIRY_MARGIN_SECONDS, Math.ceil(minTtlMs / 1000))
  }

  /**
   * Obtain a fresh access token: refresh if we hold a refresh token, otherwise
   * do the first-use exchange. Runs inside the single-flight from
   * `getCoreToken`, so only one of these is ever in flight.
   */
  private async obtainAccessToken(generation: number): Promise<string> {
    const refreshToken = await this.store.refreshToken()
    if (refreshToken) {
      try {
        return await this.refresh(refreshToken, {deferExpired: this.canExchangeFreshSubject(), generation})
      } catch (err) {
        // Only a definitive rejection of the refresh token earns a fresh subject
        // exchange. A transient failure would meet the same network, an abort
        // was the caller's answer, and a cleared session must not reacquire
        // credentials from the upstream provider.
        if (err instanceof RefreshTokenRejectedError && this.canExchangeFreshSubject()) {
          return this.exchangeAfterRejection(generation, err)
        }
        throw err
      }
    }
    return this.exchange(generation)
  }

  /**
   * One fresh subject exchange after Core rejected the refresh token (the host
   * can supply a subject token on demand). The dead refresh token is already
   * cleared, so a failure here leaves the next `getCoreToken` on the first-use
   * exchange; `onExpired` fires only if Core itself refuses the fresh subject
   * token, which is when the host really must re-authenticate.
   */
  private async exchangeAfterRejection(generation: number, rejection: RefreshTokenRejectedError): Promise<string> {
    this.assertSessionActive(generation)
    this.logger.info("refresh token rejected; exchanging fresh subject token")
    try {
      return await this.exchange(generation)
    } catch (err) {
      if (isAbortError(err)) throw err
      // A logout that raced the exchange wins over whatever the exchange came to.
      this.assertSessionActive(generation)
      if (isCoreRefusal(err, EXCHANGE_REFUSAL_ERRORS)) {
        this.fireExpired()
        throw rejection
      }
      // Already classified: a retryable failure, or a local problem that is not about the credentials.
      if (err instanceof AuthUnavailableError || err instanceof AuthExpiredError) throw err
      // The host's getSubjectToken threw (or the like): nothing was refused.
      this.logger.warn("fresh subject token could not be exchanged; keeping the session retryable", {
        error: err instanceof Error ? err.name : typeof err,
      })
      throw new AuthUnavailableError("fresh subject token could not be exchanged; try again later", {cause: err})
    }
  }

  /**
   * First-use exchange: trade the configured subject token for an access +
   * refresh pair and save them.
   *
   * Three config shapes feed this: a raw subject token, a `getSubjectToken`
   * callback (for subject tokens that expire before exchange, so we fetch one
   * fresh each time), or a pre-exchanged access/refresh pair. The last shape has
   * no subject token at all: we persist its refresh token and refresh, since we
   * only reach `exchange` when no refresh token is stored.
   */
  private async exchange(generation = this.sessionGeneration): Promise<string> {
    const config = this.requireCoreConfig()
    // Pre-exchanged credentials: seed the store and refresh, no /exchange call.
    if ("refreshToken" in config) {
      await this.saveTokenPair(
        {
          accessToken: config.accessToken,
          refreshToken: config.refreshToken,
        },
        generation,
      )
      // The seeded access token may already be near expiry, so refresh through
      // the normal path to guarantee a fresh one.
      return this.refresh(config.refreshToken, {generation})
    }

    const subject = await this.resolveSubjectToken(config)
    const body = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subject.token,
      subject_token_type: SUBJECT_TOKEN_TYPE_URN[subject.type],
    })

    const tokens = await this.requestTokens(EXCHANGE_PATH, body, "exchange", EXCHANGE_REFUSAL_ERRORS)
    await this.saveTokenPair(
      {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
      },
      generation,
    )
    // A successful exchange means credentials are live again; clear the latch so
    // a future failure can notify the host once more.
    this.expiredFired = false
    this.logger.info("exchanged subject token for access token")
    return tokens.access_token
  }

  /**
   * Refresh near expiry: trade the stored refresh token for a new access token
   * and a rotated refresh token, saving both.
   *
   * Only Core's definitive rejection of the refresh token
   * (`DEAD_REFRESH_TOKEN_ERRORS`) clears the stored state. The caller either
   * falls back to one fresh subject-token exchange (for on-demand subject-token
   * configs) or fires `onExpired` once; both surface a
   * `RefreshTokenRejectedError`. We do not retry refresh forever: a dead
   * refresh token will not heal on its own, and retrying would loop.
   *
   * Every other failure leaves the refresh token in place for the next call: it
   * says nothing about the token, and Core accepts a retry with the same token
   * even when it rotated the token and the response never arrived. Those throw
   * `AuthUnavailableError`, except an abort, which propagates unchanged.
   */
  private async refresh(refreshToken: string, opts?: {deferExpired?: boolean; generation?: number}): Promise<string> {
    const generation = opts?.generation ?? this.sessionGeneration
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    })

    let tokens: TokenResponse
    try {
      tokens = await this.requestTokens(REFRESH_PATH, body, "refresh", DEAD_REFRESH_TOKEN_ERRORS)
    } catch (err) {
      // An abort, a retryable failure and a local problem are not a rejection of the token.
      if (!isCoreRefusal(err, DEAD_REFRESH_TOKEN_ERRORS)) throw err
      // A rejection that arrives after logout is about a session that is already gone: it must
      // not notify the host, clear what a newer session saved, or send the caller to exchange.
      this.assertSessionActive(generation)
      // Core rejected the refresh token for good: drop it so we do not keep
      // presenting a known-bad token.
      await this.store.clear()
      if (!opts?.deferExpired) {
        this.fireExpired()
      }
      throw new RefreshTokenRejectedError("token refresh failed; re-auth required")
    }

    await this.saveTokenPair(
      {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
      },
      generation,
    )
    this.expiredFired = false
    this.logger.debug("refreshed access token")
    return tokens.access_token
  }

  private canExchangeFreshSubject(): boolean {
    return !!this.coreConfig && "getSubjectToken" in this.coreConfig
  }

  /**
   * Resolve the subject token to exchange, from either the static config field
   * or the `getSubjectToken` callback.
   *
   * Only reached for the two non-pre-exchanged config shapes; the caller handles
   * the pre-exchanged shape before us, so the final throw is just exhaustiveness.
   */
  private async resolveSubjectToken(config: CoreAuthConfig): Promise<{token: string; type: SubjectTokenType}> {
    if ("subjectToken" in config) {
      return {token: config.subjectToken, type: config.subjectTokenType}
    }
    if ("getSubjectToken" in config) {
      return config.getSubjectToken()
    }
    throw new AuthExpiredError("no subject token available to exchange")
  }

  private requireCoreConfig(): CoreAuthConfig {
    if (!this.coreConfig) {
      throw new AuthExpiredError("core auth is not configured; this API is unavailable in runtime-only mode")
    }
    return this.coreConfig
  }

  private requireCoreHttp(): HttpClient {
    if (!this.http) {
      throw new AuthExpiredError("core endpoint is not configured; this API is unavailable in runtime-only mode")
    }
    return this.http
  }

  private async obtainCoreBrokeredRuntimeToken(generation: number): Promise<string> {
    const fresh = this.runtimeToken
    if (fresh && !this.isExpiring(fresh.expiresAt)) {
      return fresh.token
    }

    const coreToken = await this.getCoreToken()
    const http = this.requireCoreHttp()
    const res = await http.post<RuntimeTokenResponse>(RUNTIME_TOKEN_PATH, {}, {bearer: coreToken, idempotent: true})
    if (res.token_type !== "Bearer" || !res.access_token) {
      throw new AuthExpiredError("core returned an invalid runtime token response")
    }

    this.assertSessionActive(generation)
    const expiresAt = Math.floor(Date.now() / 1000) + res.expires_in
    this.runtimeToken = {token: res.access_token, expiresAt}
    return res.access_token
  }

  /** Persist a token pair without allowing a concurrent logout to restore it. */
  private async saveTokenPair(tokens: {accessToken: string; refreshToken: string}, generation: number): Promise<void> {
    this.assertSessionActive(generation)
    await this.store.save(tokens)
    try {
      this.assertSessionActive(generation)
    } catch (error) {
      // A storage adapter may have completed its write after logout cleared the
      // key. Clear once more so the late write cannot resurrect the session.
      await this.store.clear()
      throw error
    }
  }

  /**
   * `postForm` for the calls whose failure says something about the credentials
   * (`/exchange` and `/refresh`). Settles as exactly one of:
   *  - the tokens;
   *  - the caller's abort, unchanged;
   *  - a `TokenEndpointError` that is Core's own refusal (`isCoreRefusal` with
   *    `refusals`), for the caller to act on;
   *  - an `AuthExpiredError` that is not a failed request (no Core endpoint
   *    configured), unchanged;
   *  - `AuthUnavailableError` for everything else: a network error, a timeout, a
   *    408, 429 or 5xx, a body that is not Core's JSON, any other 4xx. None of
   *    those says the credentials are bad, so the caller keeps them and retries.
   */
  private async requestTokens(
    path: string,
    body: URLSearchParams,
    label: string,
    refusals: ReadonlySet<string>,
  ): Promise<TokenResponse> {
    try {
      return await this.postForm(path, body, label)
    } catch (err) {
      if (isAbortError(err) || isCoreRefusal(err, refusals)) throw err
      if (err instanceof AuthExpiredError && !(err instanceof TokenEndpointError)) throw err
      // Core answering with an error we do not recognize still carries its status;
      // a transport or parse failure does not.
      const status = err instanceof TokenEndpointError ? err.status : undefined
      this.logger.warn("token request failed; keeping the credentials", {
        label,
        ...(status !== undefined ? {status} : {}),
        error: err instanceof Error ? err.name : typeof err,
      })
      throw new AuthUnavailableError(`${label} could not be completed; try again later`, {status, cause: err})
    }
  }

  /**
   * POST a form-encoded body to a token endpoint and parse the RFC token
   * response.
   *
   * Uses the injected HTTP transport (not the JSON `HttpClient`) because these
   * endpoints require `application/x-www-form-urlencoded` and present the
   * subject/refresh token in the body, not as a Bearer header. We never log the
   * body: it carries a token.
   */
  private async postForm(
    path: string,
    body: URLSearchParams,
    label: string,
    signal?: AbortSignal,
  ): Promise<TokenResponse> {
    const url = this.joinUrl(path)
    const res = await this.httpTransport(url, {
      method: "POST",
      headers: {"Content-Type": "application/x-www-form-urlencoded"},
      body: body.toString(),
      ...(signal ? {signal} : {}),
    })
    if (signal?.aborted) throw new Error("Core session revocation timed out")

    if (!res.ok) {
      // The body may carry an RFC `{ error, error_description }`. We keep only
      // the short `error` code (the caller decides what it means) and never the
      // description, so no token field can leak into a message a host might
      // surface.
      // Only a 400 or 401 body is ever consulted, so no other body is read.
      const code = CORE_REFUSAL_STATUSES.has(res.status) ? await this.readOauthErrorCode(res) : undefined
      this.logger.warn("auth token request failed", {label, status: res.status, ...(code ? {code} : {})})
      throw new TokenEndpointError(`${label} request failed with status ${res.status}`, res.status, code)
    }

    return (await res.json()) as TokenResponse
  }

  /** The OAuth `error` code of a refusal, or undefined when the body is not Core's `{error}` JSON. */
  private async readOauthErrorCode(res: Response): Promise<string | undefined> {
    try {
      const data: unknown = await res.json()
      const code = typeof data === "object" && data !== null ? (data as {error?: unknown}).error : undefined
      return typeof code === "string" && OAUTH_ERROR_CODE_PATTERN.test(code) ? code : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Join the core base URL and a path without a double or missing slash.
   *
   * Done by hand (not `new URL`) so a base that already carries a path prefix (a
   * proxy mount point) is preserved, matching the shared HTTP helper's joining.
   */
  private joinUrl(path: string): string {
    if (!this.baseUrl) {
      throw new AuthExpiredError("core endpoint is not configured; this API is unavailable in runtime-only mode")
    }
    const base = this.baseUrl.replace(/\/+$/, "")
    const suffix = path.replace(/^\/+/, "")
    return `${base}/${suffix}`
  }

  /**
   * Notify every `onExpired` handler exactly once per dead-credential event.
   *
   * The latch prevents a flood of notifications when many queued calls all fail
   * against the same dead refresh token; it resets on the next successful
   * exchange/refresh so a later failure can notify again.
   */
  private fireExpired(): void {
    if (this.expiredFired) return
    this.expiredFired = true
    for (const handler of this.expiredHandlers) {
      try {
        handler()
      } catch (err) {
        // A host handler throwing must not stop the others from running.
        this.logger.error("onExpired handler threw", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  private assertSessionActive(generation = this.sessionGeneration): void {
    if (this.sessionCleared || generation !== this.sessionGeneration) {
      throw new AuthExpiredError("auth session was cleared")
    }
  }
}
