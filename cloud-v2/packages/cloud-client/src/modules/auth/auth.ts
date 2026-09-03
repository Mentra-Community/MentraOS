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
 *  - Exchange, refresh, and each per-miniapp mint are single-flighted, so a
 *    reconnect storm cannot fire a burst of competing requests (and a rotated
 *    refresh token cannot be invalidated out from under a concurrent caller).
 *  - If a refresh fails and the host can fetch a fresh subject token on demand,
 *    we clear the dead refresh token and exchange once. If no fresh subject is
 *    available (or exchange also fails), `onExpired` fires once and the host
 *    re-authenticates. We do not retry forever against a dead refresh token.
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
import {AuthExpiredError} from "../../errors"
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
  // a miniapp-scoped token, cached per packageName and re-minted before expiry
  getMiniappToken(
    packageName: string,
    opts?: {minTtlMs?: number; devAttestation?: string},
  ): Promise<{token: string; expiresAt: number}>
  // Core-owned user/oem identity, read from the Core access token.
  // Runtime-only deployments do not expose this surface.
  readonly identity: {mentraUserId: string; tenantId: string}
  // clear access, refresh, runtime, and miniapp credentials for logout
  clearSession(): Promise<void>
  // refresh failed; the host must send the user back through login
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

interface RuntimeTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
}

interface RuntimeTokenEntry {
  token: string
  expiresAt: number
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

  /** Miniapp tokens cached per packageName until near expiry. */
  private readonly miniappCache = new Map<string, MiniappTokenEntry>()
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
  }) {
    this.http = deps.http
    this.store = deps.store
    this.coreConfig = deps.config.core
    this.runtimeConfig = deps.config.runtime
    this.logger = deps.logger
    this.baseUrl = deps.baseUrl
    this.httpTransport = deps.fetch ?? globalThis.fetch
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
   * Cached per packageName and re-minted only when near expiry, so a steady
   * miniapp does not hit the cloud on every call. The mint is single-flighted
   * per packageName so two near-simultaneous launches of the same miniapp share
   * one request. The access token is the Bearer here and is never exposed to the
   * miniapp; only the returned miniapp-scoped token is.
   */
  async getMiniappToken(
    packageName: string,
    opts?: {minTtlMs?: number; devAttestation?: string},
  ): Promise<{token: string; expiresAt: number}> {
    this.assertSessionActive()
    const generation = this.sessionGeneration
    const marginSeconds = this.tokenMarginSeconds(opts?.minTtlMs)
    const cached = this.miniappCache.get(packageName)
    if (cached && !this.isExpiring(cached.expiresAt, marginSeconds)) {
      return {token: cached.token, expiresAt: cached.expiresAt}
    }

    return this.store.singleFlight(`${MINIAPP_FLIGHT_PREFIX}${packageName}:${generation}`, async () => {
      // Re-check the cache inside the flight: a concurrent mint that resolved
      // while we were queued may have already filled it.
      const fresh = this.miniappCache.get(packageName)
      if (fresh && !this.isExpiring(fresh.expiresAt, marginSeconds)) {
        return {token: fresh.token, expiresAt: fresh.expiresAt}
      }

      const accessToken = await this.getCoreToken()
      const http = this.requireCoreHttp()
      const res = await http.post<MiniappTokenEntry>(
        MINIAPP_TOKEN_PATH,
        {
          packageName,
          ...(opts?.devAttestation ? {devAttestation: opts.devAttestation} : {}),
        },
        {bearer: accessToken},
      )

      this.assertSessionActive(generation)
      const entry: MiniappTokenEntry = {token: res.token, expiresAt: res.expiresAt}
      this.miniappCache.set(packageName, entry)
      this.logger.debug("minted miniapp token", {packageName})
      return {token: entry.token, expiresAt: entry.expiresAt}
    })
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
    this.sessionGeneration += 1
    this.sessionCleared = true
    let revokeError: unknown
    try {
      if (this.coreConfig && this.http) {
        const current = this.store.current()
        const refreshToken = await this.store.refreshToken()
        let accessToken: string | null = null
        if (current && current.exp > Math.floor(Date.now() / 1000)) {
          accessToken = current.accessToken
        } else if (refreshToken) {
          const body = new URLSearchParams({grant_type: "refresh_token", refresh_token: refreshToken})
          const tokens = await this.postForm(REFRESH_PATH, body, "logout refresh")
          accessToken = tokens.access_token
        }
        if (accessToken) await this.http.post(REVOKE_PATH, {}, {bearer: accessToken})
      }
    } catch (err) {
      revokeError = err
      this.logger.warn("Core session revocation failed during local logout", {
        error: (err as Error)?.message,
      })
    } finally {
      await this.store.clear()
      this.runtimeToken = null
      this.miniappCache.clear()
      this.expiredFired = false
    }
    if (revokeError) throw revokeError
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
        if (this.canExchangeFreshSubject()) {
          this.logger.info("refresh failed; exchanging fresh subject token")
          try {
            return await this.exchange(generation)
          } catch {
            this.fireExpired()
          }
        }
        throw err
      }
    }
    return this.exchange(generation)
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

    const tokens = await this.postForm(EXCHANGE_PATH, body, "exchange")
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
   * On failure (the refresh token is dead or revoked) we clear stored state.
   * The caller either falls back to one fresh subject-token exchange (for
   * on-demand subject-token configs) or fires `onExpired` once and surfaces an
   * `AuthExpiredError`. We do not retry refresh forever: a dead refresh token
   * will not heal on its own, and retrying would loop.
   */
  private async refresh(refreshToken: string, opts?: {deferExpired?: boolean; generation?: number}): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    })

    let tokens: TokenResponse
    try {
      tokens = await this.postForm(REFRESH_PATH, body, "refresh")
    } catch {
      // The refresh token is unusable: drop it so we do not keep presenting a
      // known-bad token.
      await this.store.clear()
      if (!opts?.deferExpired) {
        this.fireExpired()
      }
      throw new AuthExpiredError("token refresh failed; re-auth required")
    }

    await this.saveTokenPair(
      {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
      },
      opts?.generation ?? this.sessionGeneration,
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
    const res = await http.post<RuntimeTokenResponse>(RUNTIME_TOKEN_PATH, {}, {bearer: coreToken})
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
   * POST a form-encoded body to a token endpoint and parse the RFC token
   * response.
   *
   * Uses the injected HTTP transport (not the JSON `HttpClient`) because these
   * endpoints require `application/x-www-form-urlencoded` and present the
   * subject/refresh token in the body, not as a Bearer header. We never log the
   * body: it carries a token.
   */
  private async postForm(path: string, body: URLSearchParams, label: string): Promise<TokenResponse> {
    const url = this.joinUrl(path)
    const res = await this.httpTransport(url, {
      method: "POST",
      headers: {"Content-Type": "application/x-www-form-urlencoded"},
      body: body.toString(),
    })

    if (!res.ok) {
      // The body may carry an RFC `{ error, error_description }`, but we keep the
      // thrown detail to the status + label so no token field can leak into a
      // message a host might surface. The caller maps this to re-auth.
      this.logger.warn("auth token request failed", {label, status: res.status})
      throw new AuthExpiredError(`${label} request failed with status ${res.status}`)
    }

    return (await res.json()) as TokenResponse
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
