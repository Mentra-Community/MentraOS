import type {ActiveDeployment} from "./types"

/** Where a signed-out person signs in to this deployment. */
export function deploymentSignInRoute(deployment: ActiveDeployment): "/auth/workspace-signin" | "/auth/start" {
  return deployment.kind === "workspace" ? "/auth/workspace-signin" : "/auth/start"
}
