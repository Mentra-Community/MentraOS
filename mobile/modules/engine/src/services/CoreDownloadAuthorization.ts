export interface CoreDownloadAuthorization {
  origin: string
  bearerToken: string
}

export interface CoreDownloadAuthorizationProvider {
  getCoreUrl(): string
  getCoreDownloadAuthorization(): Promise<CoreDownloadAuthorization>
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
