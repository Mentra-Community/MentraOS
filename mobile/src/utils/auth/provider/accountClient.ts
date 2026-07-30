/**
 * @fileoverview AccountAuthProvider — talks to Cloud V2's first-party account
 * backend (`/api/account/*`), replacing the embedded Supabase client and the
 * legacy Cloud V1 token exchange (issue 019).
 *
 * The device holds ONLY Cloud V2 tokens (access + refresh). Login exchanges
 * credentials server-side; the app never sees Supabase material. cloud-client
 * gets a fresh short-lived subject token from `getSubjectToken()` and exchanges
 * it, exactly as an external OEM's app would — Mentra is just another OEM.
 */
import {AsyncResult, result as Res, Result} from "typesafe-ts"

import {AuthClient} from "@/utils/auth/authClient"
import {MentraAuthSession, MentraAuthUser, MentraSigninResponse} from "@/utils/auth/authProvider.types"
import {AuthStateListener, createAuthStateFanout} from "@/utils/auth/provider/authStateFanout"
import {randomUrlSafe, s256Challenge} from "@/utils/auth/pkce"
import {resolvedEndpoints} from "@/services/cloudClient"
import {storage} from "@/utils/storage"

const ACCESS_KEY = "mentra.account.accessToken"
const REFRESH_KEY = "mentra.account.refreshToken"
const PROFILE_KEY = "mentra.account.userProfile"
const OAUTH_STATE_KEY = "mentra.account.oauth.state"
const OAUTH_VERIFIER_KEY = "mentra.account.oauth.verifier"

type Tokens = {access: string; refresh: string}

function loadTokens(): Tokens | null {
  const a = storage.load<string>(ACCESS_KEY)
  const r = storage.load<string>(REFRESH_KEY)
  if (a.is_error() || r.is_error() || !a.value || !r.value) return null
  return {access: a.value, refresh: r.value}
}

function saveTokens(t: Tokens): void {
  storage.save(ACCESS_KEY, t.access)
  storage.save(REFRESH_KEY, t.refresh)
}

function clearTokens(): void {
  storage.remove(ACCESS_KEY)
  storage.remove(REFRESH_KEY)
  storage.remove(PROFILE_KEY)
}

/** Last successful /me result, cached so an OFFLINE cold start can restore the
 * signed-in identity instead of bouncing to /auth/start (home boot requires a
 * user, not just a token). */
function loadCachedProfile(): MentraAuthUser | undefined {
  const raw = storage.load<string>(PROFILE_KEY)
  if (raw.is_error() || !raw.value) return undefined
  try {
    return JSON.parse(raw.value) as MentraAuthUser
  } catch {
    return undefined
  }
}

function saveCachedProfile(user: MentraAuthUser): void {
  storage.save(PROFILE_KEY, JSON.stringify(user))
}

function core(path: string): string {
  return `${resolvedEndpoints().core.replace(/\/+$/, "")}${path}`
}

async function throwApiError(res: Response): Promise<never> {
  const body = await res.json().catch(() => ({}) as any)
  throw new Error(body?.error_description || body?.error || `HTTP ${res.status}`)
}

const authState = createAuthStateFanout()

export class AccountAuthProvider extends AuthClient {
  private static instance: AccountAuthProvider

  public static async getInstance(): Promise<AccountAuthProvider> {
    if (!AccountAuthProvider.instance) AccountAuthProvider.instance = new AccountAuthProvider()
    return AccountAuthProvider.instance
  }

  private notify(event: string): void {
    void this.getSession().then((r) => {
      if (r.is_ok()) authState.emit(event, r.value)
    })
  }

  public onAuthStateChange(callback: AuthStateListener): Result<any, Error> {
    const sub = authState.subscribe(callback)
    // Remove only this listener. The previous implementation cleared the shared
    // slot, so one consumer unsubscribing silenced every other consumer too.
    return Res.ok(sub)
  }

  /** Core rotates refresh tokens on every use and enforces single-use: a
   * second concurrent grant with the same (now-superseded) token gets a
   * legitimate 400 invalid_grant, even though the first grant succeeded.
   * Without this guard, two callers racing on the same expired access token
   * (e.g. AuthContext's getSession() and CloudClientService's reconnect via
   * getSubjectToken(), both firing on cold resume) would both call
   * refreshTokens() with the same stored refresh token; the loser's 400
   * would make ensureFreshAccess()/getSession() clearTokens(), wiping out
   * the winner's freshly-saved session. Sharing one in-flight promise across
   * all callers means only one grant is ever sent per rotation. */
  private refreshInFlight: Promise<Tokens | null> | null = null

  /** Run the V2 refresh grant. Returns the new tokens, or null ONLY when the
   * server definitively rejected the refresh token (`invalid_grant` or 401:
   * revoked/expired session). Throws on network failure, malformed requests,
   * and transient server errors (5xx, 429) so callers keep the tokens instead
   * of signing the user out during a client bug or brief core outage. */
  private async refreshTokens(refresh: string): Promise<Tokens | null> {
    if (this.refreshInFlight) return this.refreshInFlight
    const inFlight = this.performRefresh(refresh).finally(() => {
      if (this.refreshInFlight === inFlight) this.refreshInFlight = null
    })
    this.refreshInFlight = inFlight
    return inFlight
  }

  private async performRefresh(refresh: string): Promise<Tokens | null> {
    const res = await fetch(core("/api/client/auth/refresh"), {
      method: "POST",
      headers: {"content-type": "application/x-www-form-urlencoded"},
      // React Native's native request-body converter does not serialize a
      // URLSearchParams instance. Pass the encoded string explicitly, as the
      // cloud-client transport does, or Core receives a malformed/empty form
      // and responds with unsupported_grant_type (HTTP 400).
      body: new URLSearchParams({grant_type: "refresh_token", refresh_token: refresh}).toString(),
    })
    if (!res.ok) {
      const errorBody = (await res.json().catch(() => ({}))) as {error?: string}
      const errorCode = errorBody.error ?? "unknown_error"

      // A refresh endpoint can return several RFC-shaped 400 responses. Only
      // invalid_grant (or an authorization-level 401) proves the stored token
      // is dead. Treat malformed requests and transient failures as errors so
      // callers preserve the session instead of logging the user out.
      const refreshRejected = errorCode === "invalid_grant" || res.status === 401
      if (!refreshRejected) {
        throw new Error(`refresh failed without rejecting session: HTTP ${res.status} (${errorCode})`)
      }

      // The in-flight guard above only covers callers that both call
      // refreshTokens() while ONE request is still pending. A caller that
      // snapshotted this exact refresh token earlier (via loadTokens()) but
      // only got here after a DIFFERENT concurrent call already completed
      // and rotated it will land here with a legitimate rejection for a
      // token that is simply stale, not dead. Distinguish the two: if
      // storage now holds a different refresh token than the one we just
      // presented, someone else already won the rotation and saved a live
      // session, so hand that back instead of reporting a hard failure that
      // would make the caller clearTokens() out from under it.
      const current = loadTokens()
      if (current && current.refresh !== refresh) return current
      console.log(`MENTRA AUTH: refresh grant rejected (${errorCode}, HTTP ${res.status}), session is dead`)
      return null
    }
    const body = (await res.json()) as {access_token: string; refresh_token: string}
    const t = {access: body.access_token, refresh: body.refresh_token}
    saveTokens(t)
    return t
  }

  /** Core's userAuth rejects an expired/invalid access token as the RFC
   * `invalid_grant` shape — HTTP 400, not 401 — so both statuses mean
   * "token no longer accepted, try the refresh grant". */
  private static tokenRejected(status: number): boolean {
    return status === 400 || status === 401
  }

  /** Return a valid access token, refreshing once via the V2 refresh grant if
   * the stored one is rejected. Throws if there is no usable session. */
  private async ensureFreshAccess(): Promise<string> {
    const tokens = loadTokens()
    if (!tokens) throw new Error("not signed in")
    const probe = await fetch(core("/api/account/me"), {
      headers: {authorization: `Bearer ${tokens.access}`},
    })
    if (!AccountAuthProvider.tokenRejected(probe.status)) return tokens.access
    const refreshed = await this.refreshTokens(tokens.refresh)
    if (!refreshed) {
      console.log(`MENTRA AUTH: clearing tokens, refresh rejected after /me probe (HTTP ${probe.status})`)
      clearTokens()
      throw new Error("session expired")
    }
    return refreshed.access
  }

  public getSession(): AsyncResult<MentraAuthSession, Error> {
    return Res.try_async(async () => {
      const tokens = loadTokens()
      if (!tokens) return {token: undefined}
      let access = tokens.access
      let meRes = await fetch(core("/api/account/me"), {
        headers: {authorization: `Bearer ${access}`},
      }).catch(() => null) // null = offline; keep tokens, report no user
      if (meRes && AccountAuthProvider.tokenRejected(meRes.status)) {
        // Access token expired (1h TTL): silently refresh, then retry /me, so a
        // cold boot after an hour restores the session instead of bouncing the
        // user to /auth/start while their refresh token is still good.
        let refreshed: Tokens | null = null
        let offline = false
        try {
          refreshed = await this.refreshTokens(tokens.refresh)
        } catch {
          offline = true // network failure: not a rejection, keep tokens
        }
        if (refreshed) {
          access = refreshed.access
          meRes = await fetch(core("/api/account/me"), {
            headers: {authorization: `Bearer ${access}`},
          }).catch(() => null)
        } else if (!offline) {
          // getSession() runs on cold boot but also from deeplink auth checks
          // and reset-password, so don't claim "boot" here.
          console.log(
            `MENTRA AUTH: getSession clearing tokens, /me rejected (HTTP ${meRes?.status}) and refresh grant rejected`,
          )
          clearTokens()
          return {token: undefined}
        }
      }
      let user: MentraAuthUser | undefined
      if (meRes?.ok) {
        const me = (await meRes.json()) as {mentraUserId: string; email?: string; name?: string; avatarUrl?: string}
        user = {id: me.mentraUserId, email: me.email, name: me.name ?? me.email ?? "", avatarUrl: me.avatarUrl}
        saveCachedProfile(user)
      } else {
        // /me unreachable (offline boot) or transiently failing: restore the
        // last known identity so home boot (which requires a user, not just a
        // token) doesn't dump a signed-in user at /auth/start.
        user = loadCachedProfile()
      }
      return {token: access, user}
    })
  }

  public getUser(): AsyncResult<MentraAuthUser, Error> {
    return Res.try_async(async () => {
      const s = await this.getSession()
      if (s.is_error() || !s.value.user) throw new Error("no user")
      return s.value.user
    })
  }

  /** cloud-client calls this to get a token to exchange. We mint a fresh
   * short-lived `mentra` subject token from the account backend (the OEM
   * "mint a subject token for my app" surface). */
  public getSubjectToken(): AsyncResult<{token: string; type: string}, Error> {
    return Res.try_async(async () => {
      const access = await this.ensureFreshAccess()
      const res = await fetch(core("/api/account/subject-token"), {
        method: "POST",
        headers: {authorization: `Bearer ${access}`},
      })
      if (!res.ok) await throwApiError(res)
      const body = (await res.json()) as {token: string; type: string}
      return {token: body.token, type: body.type}
    })
  }

  public signInWithPassword(credentials: {email: string; password: string}): AsyncResult<MentraSigninResponse, Error> {
    return Res.try_async(async () => {
      const res = await fetch(core("/api/account/login"), {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(credentials),
      })
      if (!res.ok) await throwApiError(res)
      const body = (await res.json()) as {access_token: string; refresh_token: string}
      saveTokens({access: body.access_token, refresh: body.refresh_token})
      const session = await this.getSession()
      const value = session.is_ok() ? session.value : {token: body.access_token}
      // Notify synchronously with the session we already fetched (rather than via
      // notify()'s extra async /me round-trip) so AuthContext.user is populated
      // before this call resolves and the login screen navigates to "/". Otherwise
      // the home-boot auth check races the async listener and bounces to /auth/start.
      authState.emit("SIGNED_IN", value)
      return {session: value, user: value.user ?? null}
    })
  }

  public signUp(credentials: {email: string; password: string}): AsyncResult<MentraSigninResponse, Error> {
    return Res.try_async(async () => {
      const res = await fetch(core("/api/account/signup"), {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(credentials),
      })
      if (!res.ok && res.status !== 202) await throwApiError(res)
      return {session: null, user: null}
    })
  }

  public resendSignupEmail(email: string): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      await fetch(core("/api/account/verify/resend"), {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({email}),
      })
    })
  }

  public resetPasswordForEmail(email: string): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      await fetch(core("/api/account/password/forgot"), {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({email}),
      })
    })
  }

  public resetPasswordByCode(email: string, code: string, newPassword: string): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      const res = await fetch(core("/api/account/password/reset"), {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({email, code, newPassword}),
      })
      if (!res.ok) await throwApiError(res)
      const body = (await res.json()) as {access_token: string; refresh_token: string}
      saveTokens({access: body.access_token, refresh: body.refresh_token})
      this.notify("SIGNED_IN")
    })
  }

  public updateSessionWithTokens(tokens: {access_token: string; refresh_token: string}): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      saveTokens({access: tokens.access_token, refresh: tokens.refresh_token})
      this.notify("TOKEN_REFRESHED")
    })
  }

  public updateUserPassword(newPassword: string, currentPassword?: string): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      // The account backend re-verifies the current password server side; a
      // stolen session alone must not be enough to rotate the credential.
      if (!currentPassword) throw new Error("current password required")
      const access = await this.ensureFreshAccess()
      const res = await fetch(core("/api/account/password/change"), {
        method: "POST",
        headers: {"content-type": "application/json", authorization: `Bearer ${access}`},
        body: JSON.stringify({currentPassword, newPassword}),
      })
      if (!res.ok) await throwApiError(res)
    })
  }

  public updateUserEmail(newEmail: string, password?: string): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      if (!password) throw new Error("password required")
      const access = await this.ensureFreshAccess()
      const res = await fetch(core("/api/account/email/change"), {
        method: "POST",
        headers: {"content-type": "application/json", authorization: `Bearer ${access}`},
        body: JSON.stringify({newEmail, password}),
      })
      if (!res.ok && res.status !== 202) await throwApiError(res)
    })
  }

  public confirmEmailChange(code: string): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      const access = await this.ensureFreshAccess()
      const res = await fetch(core("/api/account/email/change/confirm"), {
        method: "POST",
        headers: {"content-type": "application/json", authorization: `Bearer ${access}`},
        body: JSON.stringify({code}),
      })
      if (!res.ok) await throwApiError(res)
      this.notify("USER_UPDATED")
    })
  }

  public requestAccountDeletion(): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      const access = await this.ensureFreshAccess()
      const res = await fetch(core("/api/account/delete/request"), {
        method: "POST",
        headers: {"content-type": "application/json", authorization: `Bearer ${access}`},
        body: JSON.stringify({}),
      })
      if (!res.ok && res.status !== 202) await throwApiError(res)
    })
  }

  public confirmAccountDeletion(code: string): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      const access = await this.ensureFreshAccess()
      const res = await fetch(core("/api/account/delete/confirm"), {
        method: "POST",
        headers: {"content-type": "application/json", authorization: `Bearer ${access}`},
        body: JSON.stringify({code}),
      })
      if (!res.ok) await throwApiError(res)
      // The account is gone; the server revoked every session already.
      clearTokens()
      authState.emit("SIGNED_OUT", {token: undefined})
    })
  }

  /** Build the OAuth start URL for the system browser. The PKCE verifier and
   * state stay in MMKV; only the S256 challenge leaves the device, so an
   * intercepted deep link cannot be completed without the verifier. */
  private oauthStartUrl(provider: "google" | "apple"): string {
    const state = randomUrlSafe(16)
    const verifier = randomUrlSafe(32)
    storage.save(OAUTH_STATE_KEY, state)
    storage.save(OAUTH_VERIFIER_KEY, verifier)
    const q = new URLSearchParams({state, code_challenge: s256Challenge(verifier)})
    return core(`/api/account/oauth/${provider}/start?${q}`)
  }

  public googleSignIn(): AsyncResult<string, Error> {
    return Res.try_async(async () => this.oauthStartUrl("google"))
  }

  public appleSignIn(): AsyncResult<string, Error> {
    return Res.try_async(async () => this.oauthStartUrl("apple"))
  }

  /** Deep link landed with ?code&state: verify state, swap the handoff code +
   * verifier for the V2 session at /oauth/complete. */
  public completeOAuthHandoff(params: {code: string; state: string}): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      const expectedState = storage.load<string>(OAUTH_STATE_KEY)
      const verifier = storage.load<string>(OAUTH_VERIFIER_KEY)
      if (expectedState.is_error() || verifier.is_error() || !expectedState.value || !verifier.value) {
        throw new Error("no oauth flow in progress")
      }
      if (params.state !== expectedState.value) throw new Error("oauth state mismatch")
      // Keep state+verifier until the server definitively answers: a transient
      // network failure here must leave the deep link retryable (the handoff
      // code is unconsumed server-side). Clear on success or on a definitive
      // rejection (the code is burned either way).
      let res: Response
      try {
        res = await fetch(core("/api/account/oauth/complete"), {
          method: "POST",
          headers: {"content-type": "application/json"},
          body: JSON.stringify({code: params.code, code_verifier: verifier.value}),
        })
      } catch (err) {
        throw err instanceof Error ? err : new Error(String(err))
      }
      storage.remove(OAUTH_STATE_KEY)
      storage.remove(OAUTH_VERIFIER_KEY)
      if (!res.ok) await throwApiError(res)
      const body = (await res.json()) as {access_token: string; refresh_token: string}
      if (!body?.access_token || !body?.refresh_token) throw new Error("oauth completion returned no session")
      saveTokens({access: body.access_token, refresh: body.refresh_token})
      const session = await this.getSession()
      authState.emit("SIGNED_IN", session.is_ok() ? session.value : {token: body.access_token})
    })
  }

  public startAutoRefresh(): AsyncResult<void, Error> {
    return Res.try_async(async () => {})
  }
  public stopAutoRefresh(): AsyncResult<void, Error> {
    return Res.try_async(async () => {})
  }

  public signOut(): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      const tokens = loadTokens()
      if (tokens) {
        // Refresh first if the access token expired (1h TTL): revoking with a
        // stale token 400s and would leave the server session alive even
        // though the device forgets it. Best-effort — a dead session throws
        // in ensureFreshAccess (already cleared) and offline just skips.
        const access = await this.ensureFreshAccess().catch(() => null)
        if (access) {
          await fetch(core("/api/account/logout"), {
            method: "POST",
            headers: {"content-type": "application/json", authorization: `Bearer ${access}`},
            body: JSON.stringify({}),
          }).catch(() => null)
        }
      }
      clearTokens()
      this.notify("SIGNED_OUT")
    })
  }
}
