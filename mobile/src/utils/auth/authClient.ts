import {AppState} from "react-native"
import {AsyncResult, result as Res, Result} from "typesafe-ts"

import {SETTINGS, useSettingsStore} from "@/stores/settings"

import {MentraAuthSession, MentraAuthUser, MentraSigninResponse} from "@/utils/auth/authProvider.types"
import {AuthingWrapperClient} from "@/utils/auth/provider/authingClient"
import {SupabaseWrapperClient} from "@/utils/auth/provider/supabaseClient"

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

  public signInWithPassword(_params: {email: string; password: string}): AsyncResult<MentraSigninResponse, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  public resetPasswordForEmail(_email: string): AsyncResult<void, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  public updateUserPassword(_password: string): AsyncResult<void, Error> {
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
}

function createLazyAuthClient(): AuthClient {
  let client: AuthClient | null = null
  let initPromise: Promise<AuthClient> | null = null

  const ensureInit = async (): Promise<AuthClient> => {
    if (!initPromise) {
      initPromise = (async () => {
        const isChina = useSettingsStore.getState().getSetting(SETTINGS.china_deployment.key)
        if (isChina) {
          client = await AuthingWrapperClient.getInstance()
        } else {
          client = await SupabaseWrapperClient.getInstance()
        }
        return client
      })()
    }
    return initPromise
  }

  return new Proxy({} as AuthClient, {
    get(_, prop: keyof AuthClient) {
      return async (...args: any[]) => {
        const c = await ensureInit()
        return (c[prop] as Function)(...args)
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
AppState.addEventListener("change", state => {
  if (state === "active") {
    console.log("MENTRA AUTH: START AUTO REFRESH")
    mentraAuth.startAutoRefresh()
  } else {
    console.log("MENTRA AUTH: STOP AUTO REFRESH")
    mentraAuth.stopAutoRefresh()
  }
})
