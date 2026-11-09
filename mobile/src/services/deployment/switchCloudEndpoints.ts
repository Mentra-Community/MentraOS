import {cloudClient} from "@/services/cloudClient"
import {createDeploymentAuthProvider, queueProviderCleanup} from "@/services/deployment/auth"
import {coreOverrideChangesCore, saveDeploymentCloudOverrides} from "@/services/deployment/debugOverrides"
import {deploymentSignInRoute} from "@/services/deployment/signInRoute"
import type {ActiveDeployment} from "@/services/deployment/types"
import {useCapsuleStore} from "@/stores/capsule"
import {useNavigationStore} from "@/stores/navigation"
import {LogoutUtils} from "@/utils/LogoutUtils"
import {hasStoredAccountSession} from "@/utils/auth/accountCredentials"
import {settleFrame} from "@/utils/settleFrame"

export {deploymentSignInRoute}

/** Whether this phone holds a session for the deployment. When it cannot tell, it assumes one. */
export async function hasSignedInSession(deployment: ActiveDeployment): Promise<boolean> {
  try {
    if (deployment.kind === "workspace") return Boolean(await createDeploymentAuthProvider(deployment).getSession())
    return await hasStoredAccountSession()
  } catch (error) {
    console.warn("CLOUD SWITCH: could not read the session; treating it as signed in", error)
    return true
  }
}

/**
 * Whether saving `core` as the override signs the person out: each Core has its own keys and accounts, so
 * the current session is useless on another one.
 */
export async function cloudSwitchSignsOut(deployment: ActiveDeployment, core: string): Promise<boolean> {
  return coreOverrideChangesCore(deployment, core) && (await hasSignedInSession(deployment))
}

export interface CloudSwitchResult {
  signedOut: boolean
}

/**
 * Point the deployment at new Core and Runtime URLs (empty strings restore its defaults).
 *
 * With `signOut`, the session on the current Core ends first, while that Core can still revoke it: the logout
 * clears miniapp data and closes the account's settings, which stay saved for the next sign-in to that account.
 * The glasses stay paired: they belong to the phone, and developers switch backends too often to pair again each
 * time. Then the URLs are saved, the client reconnects, and the person lands on sign-in. Nothing here depends on
 * the calling screen, which the logout may unmount.
 *
 * `navigate: false` leaves the routing to a caller that is not inside a miniapp (the boot screen).
 */
export async function switchCloudEndpoints(
  deployment: ActiveDeployment,
  urls: {core: string; runtime: string},
  options: {signOut: boolean; navigate?: boolean},
): Promise<CloudSwitchResult> {
  if (options.signOut) {
    if (options.navigate !== false) {
      // Leave the miniapp surface before the logout destroys it, as Settings' sign-out does (OS-1834):
      // tearing it down under a mounted screen crashes the React host.
      await useCapsuleStore.getState().active?.handleRightPress(true)
      await settleFrame()
      useNavigationStore.getState().replaceAll(deploymentSignInRoute(deployment))
      await settleFrame()
    }
    if (deployment.kind === "workspace") {
      await LogoutUtils.performCompleteLogout({skipAuthSignOut: true, keepGlasses: true})
      await queueProviderCleanup(createDeploymentAuthProvider(deployment))
    } else {
      await LogoutUtils.performCompleteLogout({keepGlasses: true})
    }
  }
  await saveDeploymentCloudOverrides(deployment, urls)
  cloudClient.reconnect()
  return {signedOut: options.signOut}
}
