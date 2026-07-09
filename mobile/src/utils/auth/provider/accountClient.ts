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
import {resolvedEndpoints} from "@/services/cloudClient"
import {storage} from "@/utils/storage"

const ACCESS_KEY = "mentra.account.accessToken"
const REFRESH_KEY = "mentra.account.refreshToken"

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
}

function core(path: string): string {
  return `${resolvedEndpoints().core.replace(/\/+$/, "")}${path}`
}

async function throwApiError(res: Response): Promise<never> {
  const body = await res.json().catch(() => ({}) as any)
  throw new Error(body?.error_description || body?.error || `HTTP ${res.status}`)
}

let stateCb: ((event: string, session: MentraAuthSession) => void) | null = null

export class AccountAuthProvider extends AuthClient {
  private static instance: AccountAuthProvider

  public static async getInstance(): Promise<AccountAuthProvider> {
    if (!AccountAuthProvider.instance) AccountAuthProvider.instance = new AccountAuthProvider()
    return AccountAuthProvider.instance
  }

  private notify(event: string): void {
    void this.getSession().then((r) => {
      if (r.is_ok()) stateCb?.(event, r.value)
    })
  }

  public onAuthStateChange(callback: (event: string, session: MentraAuthSession) => void): Result<any, Error> {
    stateCb = callback
    return Res.ok({unsubscribe: () => (stateCb = null)})
  }

  /** Return a valid access token, refreshing once via the V2 refresh grant if
   * the stored one is rejected. Throws if there is no usable session. */
  private async ensureFreshAccess(): Promise<string> {
    const tokens = loadTokens()
    if (!tokens) throw new Error("not signed in")
    const probe = await fetch(core("/api/account/me"), {
      headers: {authorization: `Bearer ${tokens.access}`},
    })
    if (probe.status !== 401) return tokens.access
    const refreshed = await fetch(core("/api/client/auth/refresh"), {
      method: "POST",
      headers: {"content-type": "application/x-www-form-urlencoded"},
      body: new URLSearchParams({grant_type: "refresh_token", refresh_token: tokens.refresh}),
    })
    if (!refreshed.ok) {
      clearTokens()
      throw new Error("session expired")
    }
    const body = (await refreshed.json()) as {access_token: string; refresh_token: string}
    saveTokens({access: body.access_token, refresh: body.refresh_token})
    return body.access_token
  }

  public getSession(): AsyncResult<MentraAuthSession, Error> {
    return Res.try_async(async () => {
      const tokens = loadTokens()
      if (!tokens) return {token: undefined}
      const meRes = await fetch(core("/api/account/me"), {
        headers: {authorization: `Bearer ${tokens.access}`},
      }).catch(() => null)
      let user: MentraAuthUser | undefined
      if (meRes?.ok) {
        const me = (await meRes.json()) as {mentraUserId: string; email?: string; name?: string; avatarUrl?: string}
        user = {id: me.mentraUserId, email: me.email, name: me.name ?? me.email ?? "", avatarUrl: me.avatarUrl}
      }
      return {token: tokens.access, user}
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
      stateCb?.("SIGNED_IN", value)
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
        await fetch(core("/api/account/logout"), {
          method: "POST",
          headers: {"content-type": "application/json", authorization: `Bearer ${tokens.access}`},
          body: JSON.stringify({}),
        }).catch(() => null)
      }
      clearTokens()
      this.notify("SIGNED_OUT")
    })
  }
}
