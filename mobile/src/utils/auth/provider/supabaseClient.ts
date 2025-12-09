import type {AuthChangeEvent, Session, SupabaseClient} from "@supabase/supabase-js"
import {createClient, SupportedStorage} from "@supabase/supabase-js"
import {AsyncResult, result as Res, Result} from "typesafe-ts"

import {AuthClient} from "@/utils/auth/authClient"
import {MentraAuthSession, MentraAuthUser, MentraSigninResponse} from "@/utils/auth/authProvider.types"
import {storage} from "@/utils/storage"

const SUPABASE_URL = (process.env.EXPO_PUBLIC_SUPABASE_URL as string) || "https://auth.mentra.glass"
const SUPABASE_ANON_KEY =
  (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string) ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlrYml1bnpmYmJ0d2x6ZHBybWVoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzQyODA2OTMsImV4cCI6MjA0OTg1NjY5M30.rbEsE8IRz-gb3-D0H8VAJtGw-xvipl1Nc-gCnnQ748U"

// shim to mmkv storage:
class MMKVSupabaseStorage implements SupportedStorage {
  getItem(key: string): any {
    const res = storage.load<any>(key)
    if (res.is_error()) {
      return null
    }
    return res.value
  }
  setItem(key: string, value: string): void {
    storage.save(key, value)
  }
  removeItem(key: string): void {
    storage.remove(key)
  }
}

const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: new MMKVSupabaseStorage(),
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
})

export class SupabaseWrapperClient extends AuthClient {
  private static instance: SupabaseWrapperClient
  private supabase: SupabaseClient

  private constructor() {
    super()
    this.supabase = supabaseClient
  }

  public static async getInstance(): Promise<SupabaseWrapperClient> {
    if (!SupabaseWrapperClient.instance) {
      SupabaseWrapperClient.instance = new SupabaseWrapperClient()
    }
    return SupabaseWrapperClient.instance
  }

  public onAuthStateChange(callback: (event: string, session: any) => void): Result<any, Error> {
    const wrappedCallback = (event: AuthChangeEvent, session: Session | null) => {
      // Only create a session object if we have a valid session
      const modifiedSession = session
        ? {
            token: session.access_token,
            user: {
              id: session.user.id,
              email: session.user.email,
              name: session.user.user_metadata.full_name as string,
              avatarUrl: session.user.user_metadata?.avatar_url || session.user.user_metadata?.picture,
              createdAt: session.user.created_at,
              provider: session.user.user_metadata.provider,
            },
          }
        : null

      // console.log("supabaseClient: Modified session:", modifiedSession)

      callback(event, modifiedSession)
    }

    const {data} = this.supabase.auth.onAuthStateChange(wrappedCallback)

    return Res.ok(data)
  }

  public getUser(): AsyncResult<MentraAuthUser, Error> {
    return Res.try_async(async () => {
      const {data, error} = await this.supabase.auth.getUser()
      if (error) {
        throw error
      }
      if (!data.user) {
        throw new Error("User not found")
      }
      return {
        id: data.user.id,
        email: data.user.email,
        name: (data.user.user_metadata.full_name || data.user.user_metadata.name || "") as string,
        avatarUrl: data.user.user_metadata?.avatar_url || data.user.user_metadata?.picture,
        createdAt: data.user.created_at,
        provider: data.user.user_metadata.provider,
      }
    })
  }

  public getSession(): AsyncResult<MentraAuthSession, Error> {
    return Res.try_async(async () => {
      const {data, error} = await this.supabase.auth.getSession()
      if (error) {
        throw error
      }
      if (!data.session || !data.session.user?.id) {
        return {
          token: undefined,
          user: undefined,
        }
      }
      return {
        token: data.session.access_token,
        user: {
          id: data.session.user.id,
          email: data.session.user.email,
          name: (data.session.user.user_metadata?.full_name || "") as string,
        },
      }
    })
  }

  public updateSessionWithTokens(tokens: {access_token: string; refresh_token: string}): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      const {error} = await this.supabase.auth.setSession(tokens)
      if (error) {
        throw new Error(error.message)
      }
    })
  }

  public startAutoRefresh(): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      await this.supabase.auth.startAutoRefresh()
      return undefined
    })
  }

  public stopAutoRefresh(): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      await this.supabase.auth.stopAutoRefresh()
      return undefined
    })
  }

  public signOut(): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      const {error} = await this.supabase.auth.signOut()
      if (error) {
        throw error
      }
      return undefined
    })
  }

  public signInWithPassword(credentials: {email: string; password: string}): AsyncResult<MentraSigninResponse, Error> {
    return Res.try_async(async () => {
      const {data, error} = await this.supabase.auth.signInWithPassword(credentials)

      if (error) {
        throw error
      }

      if (!data.user) {
        throw new Error("User not found")
      }

      return {
        session: {
          token: data.session.access_token,
          user: {
            id: data.user.id,
            email: data.user.email,
            name: data.user.user_metadata.full_name as string,
          },
        },
        user: {
          id: data.user.id,
          email: data.user.email,
          name: data.user.user_metadata.full_name as string,
        },
      }
    })
  }

  public signUp(credentials: {email: string; password: string}): AsyncResult<MentraSigninResponse, Error> {
    return Res.try_async(async () => {
      const {data, error} = await this.supabase.auth.signUp(credentials)

      if (error) {
        console.log("Supabase Sign-up error:", error)
        const errorMessage = error.message.toLowerCase()
        // Try to detect if it's a Google or Apple account
        // Note: Supabase doesn't always tell us which provider, so we show a generic message
        if (
          errorMessage.includes("already registered") ||
          errorMessage.includes("user already registered") ||
          errorMessage.includes("email already exists") ||
          errorMessage.includes("identity already linked")
        ) {
          throw new Error("Email already registered")
        }
        throw error
      }

      return {
        user: data.user
          ? {
              id: data.user.id,
              email: data.user.email,
              name: data.user.user_metadata.full_name as string,
            }
          : null,
        session:
          data.session && data.user
            ? {
                token: data.session.access_token,
                user: {
                  id: data.user.id,
                  email: data.user.email,
                  name: data.user.user_metadata.full_name as string,
                },
              }
            : null,
      }
    })
  }

  public updateUserPassword(password: string): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      const {error} = await this.supabase.auth.updateUser({
        password,
      })
      if (error) {
        throw error
      }
      return undefined
    })
  }

  public resetPasswordForEmail(email: string): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      const {error} = await this.supabase.auth.resetPasswordForEmail(email)
      if (error) {
        throw error
      }
      return undefined
    })
  }

  public googleSignIn(): AsyncResult<string, Error> {
    return Res.try_async(async () => {
      const {data, error} = await this.supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          // Must match the deep link scheme/host/path in your AndroidManifest.xml
          redirectTo: "com.mentra://auth/callback",
          skipBrowserRedirect: true,
          queryParams: {
            prompt: "select_account",
          },
        },
      })

      let errorMessage = error ? error.message.toLowerCase() : ""

      if (
        errorMessage.includes("already registered") ||
        errorMessage.includes("user already registered") ||
        errorMessage.includes("email already exists") ||
        errorMessage.includes("identity already linked")
      ) {
        errorMessage = "Email already registered"
      }

      if (error) {
        throw error
      }

      return data.url
    })
  }

  public appleSignIn(): AsyncResult<string, Error> {
    return Res.try_async(async () => {
      const {data, error} = await this.supabase.auth.signInWithOAuth({
        provider: "apple",
        options: {
          // Must match the deep link scheme/host/path in your AndroidManifest.xml
          redirectTo: "com.mentra://auth/callback",
          skipBrowserRedirect: true,
          queryParams: {
            prompt: "select_account",
          },
        },
      })

      if (error) {
        const errorMessage = error.message.toLowerCase()
        if (
          errorMessage.includes("already registered") ||
          errorMessage.includes("user already registered") ||
          errorMessage.includes("email already exists") ||
          errorMessage.includes("identity already linked")
        ) {
          throw new Error("Email already registered")
        }
        throw error
      }

      if (!data.url) {
        throw new Error("No URL returned from Supabase")
      }

      return data.url
    })
  }
}
