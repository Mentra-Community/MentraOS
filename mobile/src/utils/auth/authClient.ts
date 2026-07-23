import {AppState} from "react-native"
import {AsyncResult, result as Res, Result} from "typesafe-ts"

import {SETTINGS, engine} from "@mentra/engine"
import {MentraAuthSession, MentraAuthUser, MentraSigninResponse} from "@/utils/auth/authProvider.types"
import {AuthingWrapperClient} from "@/utils/auth/provider/authingClient"
import {AccountAuthProvider} from "@/utils/auth/provider/accountClient"

export abstract class AuthClient {
  public onAuthStateChange(_callback: (event: string, session: MentraAuthSession) => void): Result<any, Error> {
    return Res.error(new Error("Method not implemented"))
  }

  public getUser(): AsyncResult<MentraAuthUser, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  public signUp(_params: {email: string; password: string}): AsyncResult<MentraSigninResponse, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  public resendSignupEmail(_email: string): AsyncResult<void, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  public signInWithPassword(_params: {email: string; password: string}): AsyncResult<MentraSigninResponse, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  public resetPasswordForEmail(_email: string): AsyncResult<void, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  public resetPasswordByCode(_email: string, _code: string, _newPassword: string): AsyncResult<void, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  public updateUserPassword(_password: string, _currentPassword?: string): AsyncResult<void, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  public updateUserEmail(_email: string, _password?: string): AsyncResult<void, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  /** Second step of the email change: the code emailed to the NEW address. */
  public confirmEmailChange(_code: string): AsyncResult<void, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  /** Start account deletion: the backend emails a confirmation code. */
  public requestAccountDeletion(): AsyncResult<void, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  /** Finish account deletion with the emailed code. Destroys the account. */
  public confirmAccountDeletion(_code: string): AsyncResult<void, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  public getSession(): AsyncResult<MentraAuthSession, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  public updateSessionWithTokens(_tokens: {access_token: string; refresh_token: string}): AsyncResult<void, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  public startAutoRefresh(): AsyncResult<void, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  public stopAutoRefresh(): AsyncResult<void, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  public signOut(): AsyncResult<void, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  public appleSignIn(): AsyncResult<string, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  public googleSignIn(): AsyncResult<string, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  /** Return a token cloud-client can exchange at /api/client/auth/exchange.
   * Providers back this differently (Supabase session token vs a minted OEM
   * subject token). */
  public getSubjectToken(): AsyncResult<{token: string; type: string}, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  /** Finish an OAuth flow: the deep link handed back `?code&state`; swap the
   * handoff code + the in-app PKCE verifier for a session. */
  public completeOAuthHandoff(_params: {code: string; state: string}): AsyncResult<void, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }
}

function createLazyAuthClient(): AuthClient {
  let client: AuthClient | null = null
  let initPromise: Promise<AuthClient> | null = null

  const ensureInit = async (): Promise<AuthClient> => {
    if (!initPromise) {
      initPromise = (async () => {
        const isChina = engine.settings.get(SETTINGS.china_deployment.key)
        if (isChina) {
          client = await AuthingWrapperClient.getInstance()
        } else {
          // Cloud V2 account auth (issue 019): Mentra's own OEM backend, no
          // embedded Supabase, no legacy Cloud V1 exchange.
          client = await AccountAuthProvider.getInstance()
        }
        return client
      })()
    }
    return initPromise
  }

  return new Proxy({} as AuthClient, {
    get(_, prop: keyof AuthClient) {
      return async (...args: unknown[]) => {
        const c = await ensureInit()
        const method = c[prop]
        if (typeof method === "function") {
          return (method as (...args: unknown[]) => unknown).apply(c, args)
        }
        return method
      }
    },
  })
}

const mentraAuth = createLazyAuthClient()
export default mentraAuth

// Tells Authing and Supabase Auth to continuously refresh the session automatically
// if the app is in the foreground. When this is added, you will continue
// to receive `onAuthStateChange` events with the `TOKEN_REFRESHED` or
// `SIGNED_OUT` event if the user's session is terminated. This should
// only be registered once.
AppState.addEventListener("change", (state) => {
  if (state === "active") {
    console.log("MENTRA AUTH: START AUTO REFRESH")
    mentraAuth.startAutoRefresh()
  } else {
    console.log("MENTRA AUTH: STOP AUTO REFRESH")
    mentraAuth.stopAutoRefresh()
  }
})
