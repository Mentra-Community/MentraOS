export interface WorkspaceIdentity {
  deploymentId: string
  issuer: string
  subject: string
  email?: string
  displayName?: string
}

export interface WorkspaceTokenRequest {
  scopes: string[]
  forceRefresh?: boolean
}

export interface DeploymentAuthSession {
  identity: WorkspaceIdentity
  accessToken?: string
}

export interface DeploymentAuthProvider {
  getSession(): Promise<DeploymentAuthSession | null>
  signIn(): Promise<DeploymentAuthSession>
  getAccessToken(request: WorkspaceTokenRequest): Promise<string>
  signOut(): Promise<void>
  onStateChange(listener: (session: DeploymentAuthSession | null) => void): () => void
}
