import {EventEmitter} from "events"

import {AuthenticationClient} from "authing-js-sdk"
import type {AuthenticationClientOptions, User} from "authing-js-sdk"

import {MentraAuthSession, MentraAuthUser, MentraSigninResponse} from "@/utils/auth/authProvider.types"
import {storage} from "@/utils/storage/storage"
import {Result, result as Res, AsyncResult} from "typesafe-ts"
import {AuthClient} from "@/utils/auth/authClient"

interface Session {
  access_token?: string
  refresh_token?: string
  expires_at?: number
  user?: User
}

const SESSION_KEY = "authing_session"

type AuthChangeEvent =
  | "SIGNED_IN"
  | "SIGNED_OUT"
  | "TOKEN_REFRESHED"
  | "USER_UPDATED"
  | "USER_DELETED"
  | "PASSWORD_RECOVERY"

type AuthChangeCallback = (event: AuthChangeEvent, session: any) => void

export class AuthingWrapperClient extends AuthClient {
  private authing: AuthenticationClient
  private eventEmitter: EventEmitter
  private refreshTimeout: ReturnType<typeof setTimeout> | null = null
  private static instance: AuthingWrapperClient

  private constructor() {
    super()
    const authingOptions: AuthenticationClientOptions = {
      appId: process.env.EXPO_PUBLIC_AUTHING_APP_ID || "",
      appHost: process.env.EXPO_PUBLIC_AUTHING_APP_HOST || "",
      lang: "en-US",
    }
    this.authing = new AuthenticationClient(authingOptions)
    this.eventEmitter = new EventEmitter()
    this.setupTokenRefresh()
  }

  public static async getInstance(): Promise<AuthingWrapperClient> {
    console.log("AuthingWrapperClient: getInstance()")
    if (!AuthingWrapperClient.instance) {
      AuthingWrapperClient.instance = new AuthingWrapperClient()
      const res = await AuthingWrapperClient.instance.readSessionFromStorage()
      if (res.is_error()) {
        return AuthingWrapperClient.instance
      }
      const session = res.value

      if (session?.access_token) {
        AuthingWrapperClient.instance.authing.setToken(session.access_token)
        if (session.user) {
          AuthingWrapperClient.instance.authing.setCurrentUser(session.user)
        }
      }
    }
    return AuthingWrapperClient.instance
  }

  public onAuthStateChange(callback: AuthChangeCallback): Result<any, Error> {
    console.log("AuthingWrapperClient: onAuthStateChange()")
    const handler = (event: string, session: MentraAuthSession) => {
      callback(event as AuthChangeEvent, session)
    }

    this.eventEmitter.on("SIGNED_IN", (session: MentraAuthSession) => handler("SIGNED_IN", session))
    this.eventEmitter.on("SIGNED_OUT", (session: MentraAuthSession) => handler("SIGNED_OUT", session))
    this.eventEmitter.on("TOKEN_REFRESHED", (session: MentraAuthSession) => handler("TOKEN_REFRESHED", session))
    this.eventEmitter.on("USER_UPDATED", (session: MentraAuthSession) => handler("USER_UPDATED", session))
    this.eventEmitter.on("USER_DELETED", (session: MentraAuthSession) => handler("USER_DELETED", session))
    this.eventEmitter.on("PASSWORD_RECOVERY", (session: MentraAuthSession) => handler("PASSWORD_RECOVERY", session))

    return Res.ok({
      unsubscribe: () => {
        this.eventEmitter.off("SIGNED_IN", handler)
        this.eventEmitter.off("SIGNED_OUT", handler)
        this.eventEmitter.off("TOKEN_REFRESHED", handler)
        this.eventEmitter.off("USER_UPDATED", handler)
        this.eventEmitter.off("USER_DELETED", handler)
        this.eventEmitter.off("PASSWORD_RECOVERY", handler)
      },
    })
  }

  public getUser(): AsyncResult<MentraAuthUser, Error> {
    console.log("AuthingWrapperClient: getUser()")
    return Res.try_async(async () => {
      const user = await this.authing.getCurrentUser()
      if (!user) {
        throw new Error("Error getting user")
      }
      let mentraUser: MentraAuthUser = {
        id: user.id,
        email: user.email!,
        name: user.name || "",
        avatarUrl: user.photo || "",
        createdAt: user.createdAt as string,
        provider: user.identities?.[0]?.provider as string,
      }
      return mentraUser
    })
  }

  public signUp(credentials: {email: string; password: string}): AsyncResult<MentraSigninResponse, Error> {
    console.log("AuthingWrapperClient: signUp()")
    return Res.try_async(async () => {
      const user = await this.authing.registerByEmail(credentials.email, credentials.password)
      if (!user) {
        throw new Error("Error signing up")
      }
      let mentraUser: MentraAuthUser = {
        id: user.id,
        email: user.email!,
        name: user.name || "",
        avatarUrl: user.photo || "",
        createdAt: user.createdAt as string,
        provider: user.identities?.[0]?.provider as string,
      }
      let mentraSession: MentraAuthSession = {
        token: user.token as string,
        user: mentraUser,
      }
      let mentraSigninResponse: MentraSigninResponse = {
        session: mentraSession,
        user: mentraUser,
      }
      return mentraSigninResponse
    })
  }

  public signInWithPassword(credentials: {email: string; password: string}): AsyncResult<MentraSigninResponse, Error> {
    console.log("AuthingWrapperClient: signInWithPassword()")
    return Res.try_async(async () => {
      const user = await this.authing.loginByEmail(credentials.email, credentials.password)
      const token = user.token
      const tokenExpiresAt = user.tokenExpiredAt && new Date(user.tokenExpiredAt).getTime()

      console.log("Token expires at:", tokenExpiresAt)

      if (token && tokenExpiresAt) {
        const session: Session = {
          access_token: token,
          refresh_token: undefined, // TODO: Update this when implementing refresh token flow
          expires_at: Number(tokenExpiresAt),
          user,
        }
        await this.saveSession(session)
        const authSession: MentraAuthSession = {
          token: session.access_token,
          user: {
            id: session.user!.id,
            email: session.user!.email!,
            name: session.user!.name || "",
          },
        }
        this.eventEmitter.emit("SIGNED_IN", authSession)
        this.setupTokenRefresh()
        let mentraUser: MentraAuthUser = {
          id: session.user!.id,
          email: session.user!.email!,
          name: session.user!.name || "",
        }
        let mentraSigninResponse: MentraSigninResponse = {
          session: authSession,
          user: mentraUser,
        }
        return mentraSigninResponse
      }

      throw new Error("Failed to sign in")
    })
  }

  public signOut(): AsyncResult<void, Error> {
    console.log("AuthingWrapperClient: signOut()")
    return Res.try_async(async () => {
      await this.authing.logout()
      await this.clearSession()
      this.eventEmitter.emit("SIGNED_OUT", null)
    })
  }

  public getSession(): AsyncResult<MentraAuthSession, Error> {
    console.log("AuthingWrapperClient: getSession()")
    const res = this.readSessionFromStorage()
    if (res.is_error()) {
      console.error("Error loading session:", res.error)
      return Res.error_async(res.error)
    }
    const session = res.value
    return Res.ok_async({
      token: session.access_token,
      user: {
        id: session.user!.id,
        email: session.user!.email!,
        name: session.user!.name || "",
      },
    })
  }

  private readSessionFromStorage(): Result<Session, Error> {
    const res = storage.load<Session>(SESSION_KEY)
    return res
  }

  private async setupTokenRefresh() {
    try {
      const res = await this.readSessionFromStorage()
      if (res.is_error()) {
        console.error("Error loading session:", res.error)
        return
      }
      const session = res.value
      if (!session?.access_token) return

      const now = Date.now()
      const expiresIn = session.expires_at! - now

      // If token is expired, clear session and emit SIGNED_OUT event
      if (expiresIn <= 0) {
        await this.clearSession()
        this.eventEmitter.emit("SIGNED_OUT", null)
        return
      }

      // Set timeout to refresh token before it expires (5 minutes before)
      const refreshTime = Math.max(0, expiresIn - 5 * 60 * 1000)

      this.refreshTimeout = setTimeout(async () => {
        try {
          await this.refreshToken()
          const user = await this.getCurrentUser()
          this.eventEmitter.emit("TOKEN_REFRESHED", user)
        } catch (error) {
          console.error("Token refresh failed:", error)
          await this.clearSession()
          this.eventEmitter.emit("SIGNED_OUT", null)
        }
      }, refreshTime)
    } catch (error) {
      console.error("Error setting up token refresh:", error)
      await this.clearSession()
    }
  }

  private async refreshToken(): Promise<void> {
    try {
      const user = await this.authing.getCurrentUser()
      if (!user) {
        throw new Error("No user session")
      }
      // The authing-js-sdk should handle token refresh automatically
      // when making authenticated requests if the token is expired
      // This is just a placeholder in case you need custom refresh logic
      // For now throwing error
      // TODO: To be implemented and tested
      throw new Error("Token refresh not implemented")
      return
    } catch (error) {
      console.error("Failed to refresh token:", error)
      throw error
    }
  }

  public startAutoRefresh(): AsyncResult<void, Error> {
    this.setupTokenRefresh()
    return Res.ok_async(undefined)
  }

  public stopAutoRefresh(): AsyncResult<void, Error> {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout)
      this.refreshTimeout = null
    }
    return Res.ok_async(undefined)
  }

  private async getCurrentUser(): Promise<User | null> {
    try {
      return await this.authing.getCurrentUser()
    } catch (error) {
      console.error("Error getting current user:", error)
      return null
    }
  }

  private async saveSession(session: Session): Promise<void> {
    const res = await storage.save(SESSION_KEY, session)
    if (res.is_error()) {
      console.error("Failed to save session", res.error)
    }
  }

  private async clearSession(): Promise<void> {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout)
      this.refreshTimeout = null
    }
    const res = await storage.remove(SESSION_KEY)
    if (res.is_error()) {
      console.error("Failed to clear session", res.error)
    }
    // clears the session and user
    this.authing.logout()
  }

  public resetPasswordForEmail(_email: string): AsyncResult<any, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  public updateUserPassword(_password: string): AsyncResult<void, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  public updateSessionWithTokens(_tokens: {access_token: string; refresh_token: string}): AsyncResult<void, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  public appleSignIn(): AsyncResult<string, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }

  public googleSignIn(): AsyncResult<string, Error> {
    return Res.error_async(new Error("Method not implemented"))
  }
}

export const authingClient = AuthingWrapperClient.getInstance()
