export interface CoreDownloadAuthorization {
  origin: string
  bearerToken: string
}

export interface CoreDownloadAuthorizationProvider {
  getCoreUrl(): string
  getCoreDownloadAuthorization(): Promise<CoreDownloadAuthorization>
}

export interface CoreDownloadCredentialSnapshot {
  /** Object identity of the Cloud client whose auth session mints the token. */
  client: object
  origin: string
  getBearerToken(): Promise<string>
}

/** Mint a credential that cannot be relabeled if the active Core reconnects. */
export async function mintCoreDownloadAuthorization(
  getSnapshot: () => CoreDownloadCredentialSnapshot | null,
): Promise<CoreDownloadAuthorization> {
  const snapshot = getSnapshot()
  if (!snapshot) throw new Error("cloud client core is unavailable")
  const origin = new URL(snapshot.origin).origin
  const bearerToken = await snapshot.getBearerToken()
  const current = getSnapshot()
  if (!current || current.client !== snapshot.client || new URL(current.origin).origin !== origin) {
    throw new Error("Core endpoint changed while minting bundle authorization")
  }
  return {origin, bearerToken}
}

/**
 * Attach a host-owned Core credential only when the bundle is on the active
 * runtime-resolved Core origin. The provider rechecks its origin when minting
 * the credential, so a reconnect cannot forward a token to the old endpoint.
 */
export async function resolveCoreDownloadAuthorization(
  bundleUrl: string,
  provider: CoreDownloadAuthorizationProvider,
): Promise<CoreDownloadAuthorization | undefined> {
  const bundleOrigin = new URL(bundleUrl).origin
  const activeCoreOrigin = new URL(provider.getCoreUrl()).origin
  if (bundleOrigin !== activeCoreOrigin) return undefined

  const authorization = await provider.getCoreDownloadAuthorization()
  if (new URL(authorization.origin).origin !== bundleOrigin) {
    throw new Error("Core endpoint changed while authorizing bundle download")
  }
  return authorization
}
