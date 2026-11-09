import type {DeploymentAuthProvider} from "./DeploymentAuthProvider"

// Native provider sign-out (MSAL) removes every cached account for the client
// id, so a sign-out still running from a previous workspace visit must finish
// before a new interactive sign-in stores its account.
let pendingProviderCleanup: Promise<void> = Promise.resolve()

/** Sign the provider out after any sign-out already queued. Never rejects. */
export function queueProviderCleanup(provider: DeploymentAuthProvider): Promise<void> {
  const cleanup = pendingProviderCleanup.then(() =>
    provider.signOut().catch((error) => {
      console.warn("Workspace auth: failed to clear the provider account", error)
    }),
  )
  pendingProviderCleanup = cleanup
  return cleanup
}

/** Resolves once every queued provider sign-out has finished. */
export function providerCleanupSettled(): Promise<void> {
  return pendingProviderCleanup
}
