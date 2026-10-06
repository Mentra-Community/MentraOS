export interface OrganizationIdentity {
  deploymentId: string
  issuer: string
  subject: string
  email?: string
  displayName?: string
}

export interface OrganizationTokenRequest {
  scopes: string[]
  forceRefresh?: boolean
}

export interface DeploymentAuthSession {
  identity: OrganizationIdentity
  accessToken?: string
}

export interface DeploymentAuthProvider {
  getSession(): Promise<DeploymentAuthSession | null>
  signIn(): Promise<DeploymentAuthSession>
  getAccessToken(request: OrganizationTokenRequest): Promise<string>
  signOut(): Promise<void>
  onStateChange(listener: (session: DeploymentAuthSession | null) => void): () => void
}
