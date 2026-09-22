import EntraAuth, {type EntraAccount, type EntraConfiguration, type EntraTokenResult} from "@mentra/entra-auth"

import type {MicrosoftEntraAuthConfig, WorkspaceDeployment} from "@/services/deployment/types"
import type {
  DeploymentAuthProvider,
  DeploymentAuthSession,
  WorkspaceIdentity,
  WorkspaceTokenRequest,
} from "./DeploymentAuthProvider"

interface NativeEntraAuth {
  getAccount(configuration: EntraConfiguration): Promise<EntraAccount | null>
  signIn(configuration: EntraConfiguration, scopes: string[]): Promise<EntraTokenResult>
  acquireToken(configuration: EntraConfiguration, scopes: string[], forceRefresh?: boolean): Promise<EntraTokenResult>
  signOut(configuration: EntraConfiguration): Promise<void>
}

export class MicrosoftEntraDeploymentAuthProvider implements DeploymentAuthProvider {
  private readonly listeners = new Set<(session: DeploymentAuthSession | null) => void>()
  private readonly auth: MicrosoftEntraAuthConfig
  private readonly native: NativeEntraAuth

  constructor(
    private readonly deployment: WorkspaceDeployment,
    native: NativeEntraAuth | null = EntraAuth,
  ) {
    if (deployment.manifest.auth.mode !== "microsoft-entra") {
      throw new Error("MicrosoftEntraDeploymentAuthProvider requires microsoft-entra auth")
    }
    if (!native) throw new Error("Microsoft Entra authentication is unavailable in this Mentra App build")
    this.auth = deployment.manifest.auth
    this.native = native
  }

  async getSession(): Promise<DeploymentAuthSession | null> {
    const account = await this.native.getAccount(this.configuration())
    if (!account) return null
    try {
      const token = await this.native.acquireToken(this.configuration(), this.auth.sessionScopes, false)
      return this.session(token, token.accessToken)
    } catch {
      // The cached account is still useful for showing the correct workspace
      // sign-in screen. An interactive request will satisfy MFA or Conditional
      // Access when silent acquisition cannot.
      return this.session(account)
    }
  }

  async signIn(): Promise<DeploymentAuthSession> {
    const result = await this.native.signIn(this.configuration(), this.auth.sessionScopes)
    const session = this.session(result, result.accessToken)
    this.emit(session)
    return session
  }

  /**
   * Mint a workspace access token for one declared scope set.
   *
   * The ACS Teams scope set is the only native-meeting capability the app can
   * exercise today, so it is the enforcement point for
   * `features.nativeMeetings`: a workspace that turns the feature off cannot
   * obtain a Teams token even though its manifest still declares the scopes.
   */
  async getAccessToken(request: WorkspaceTokenRequest): Promise<string> {
    const scopes = request.scopes.length > 0 ? request.scopes : this.auth.sessionScopes
    const uniqueScopes = new Set(scopes)
    const matches = (declared: string[]) =>
      declared.length > 0 && uniqueScopes.size === scopes.length && scopes.every((scope) => declared.includes(scope))
    if (matches(this.auth.teamsScopes) && !this.deployment.manifest.features.nativeMeetings) {
      throw new Error("Native meetings are disabled by this deployment")
    }
    if (!matches(this.auth.sessionScopes) && !matches(this.auth.teamsScopes)) {
      throw new Error("Requested Microsoft scopes are not declared by this workspace")
    }
    const result = await this.native.acquireToken(this.configuration(), scopes, request.forceRefresh)
    return result.accessToken
  }

  async signOut(): Promise<void> {
    await this.native.signOut(this.configuration())
    this.emit(null)
  }

  onStateChange(listener: (session: DeploymentAuthSession | null) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private configuration(): EntraConfiguration {
    return {authorityUrl: this.auth.authorityUrl, clientId: this.auth.clientId}
  }

  private session(account: EntraAccount, accessToken?: string): DeploymentAuthSession {
    return {
      identity: this.identity(account),
      ...(accessToken ? {accessToken} : {}),
    }
  }

  private identity(account: EntraAccount): WorkspaceIdentity {
    return {
      deploymentId: this.deployment.manifest.deploymentId,
      issuer: this.auth.authorityUrl.replace(/\/$/, ""),
      subject: account.subject,
      ...(account.username ? {email: account.username} : {}),
      ...(account.displayName ? {displayName: account.displayName} : {}),
    }
  }

  private emit(session: DeploymentAuthSession | null): void {
    for (const listener of this.listeners) listener(session)
  }
}
