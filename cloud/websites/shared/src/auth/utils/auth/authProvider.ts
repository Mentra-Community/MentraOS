import {AuthingWrapperClient} from "./provider/authingClient"
import {SupabaseWrapperClient} from "./provider/supabaseClient"
import {
  MentraAuthSessionResponse,
  MentraAuthStateChangeSubscriptionResponse,
  MentraOauthProviderResponse,
  MentraPasswordResetResponse,
  MentraSigninResponse,
  MentraSignOutResponse,
} from "./authingProvider.types"

const DEPLOYMENT_REGION = import.meta.env.VITE_DEPLOYMENT_REGION || "global"
const IS_CHINA = DEPLOYMENT_REGION === "china"

class MentraAuthProvider {
  constructor() {
    this.supabaseClient = new SupabaseWrapperClient()
    this.authingClient = new AuthingWrapperClient()
  }

  private supabaseClient: SupabaseWrapperClient
  private authingClient: AuthingWrapperClient

  async getSession(): Promise<MentraAuthSessionResponse> {
    if (IS_CHINA) {
      return this.authingClient.getSession()
    } else {
      return this.supabaseClient.getSession()
    }
  }

  async signInWithEmail(email: string, password: string): Promise<MentraSigninResponse> {
    if (IS_CHINA) {
      return this.authingClient.signInWithEmail(email, password)
    } else {
      return this.supabaseClient.signInWithEmail(email, password)
    }
  }

  async signOut(): Promise<MentraSignOutResponse> {
    if (IS_CHINA) {
      return this.authingClient.signOut()
    } else {
      return this.supabaseClient.signOut()
    }
  }

  async signUpWithEmail(email: string, password: string, redirectTo?: string): Promise<MentraSigninResponse> {
    if (IS_CHINA) {
      return this.authingClient.signUpWithEmail(email, password, redirectTo)
    } else {
      return this.supabaseClient.signUpWithEmail(email, password, redirectTo)
    }
  }

  onAuthStateChange(callback: (event: string, session: any) => void): MentraAuthStateChangeSubscriptionResponse {
    if (IS_CHINA) {
      return this.authingClient.onAuthStateChange(callback)
    } else {
      return this.supabaseClient.onAuthStateChange(callback)
    }
  }

  async resetPasswordForEmail(email: string, redirectTo?: string): Promise<MentraPasswordResetResponse> {
    if (IS_CHINA) {
      throw new Error("Method not implemented.")
    } else {
      return this.supabaseClient.resetPasswordForEmail(email, redirectTo)
    }
  }

  async refreshUser(): Promise<MentraAuthSessionResponse> {
    if (IS_CHINA) {
      throw new Error("Method not implemented.")
    } else {
      return this.supabaseClient.refreshUser()
    }
  }

  async appleSignIn(redirectTo?: string): Promise<MentraOauthProviderResponse> {
    if (IS_CHINA) {
      throw new Error("Apple sign in not supported in China")
    } else {
      return this.supabaseClient.appleSignIn(redirectTo)
    }
  }

  async googleSignIn(redirectTo?: string): Promise<MentraOauthProviderResponse> {
    if (IS_CHINA) {
      throw new Error("Google sign in not supported in China")
    } else {
      return this.supabaseClient.googleSignIn(redirectTo)
    }
  }
}

export const mentraAuthProvider = new MentraAuthProvider()
