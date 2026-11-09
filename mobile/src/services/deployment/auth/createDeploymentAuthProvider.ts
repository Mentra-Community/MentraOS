import type {WorkspaceDeployment} from "@/services/deployment/types"
import type {DeploymentAuthProvider} from "./DeploymentAuthProvider"
import {MicrosoftEntraDeploymentAuthProvider} from "./MicrosoftEntraDeploymentAuthProvider"

// One provider per deployment, so a sign-out started outside AuthContext (a
// Core URL switch) reaches the listener AuthContext registered on it.
const providers = new WeakMap<WorkspaceDeployment, DeploymentAuthProvider>()

export function createDeploymentAuthProvider(deployment: WorkspaceDeployment): DeploymentAuthProvider {
  const existing = providers.get(deployment)
  if (existing) return existing
  const provider = newProvider(deployment)
  providers.set(deployment, provider)
  return provider
}

function newProvider(deployment: WorkspaceDeployment): DeploymentAuthProvider {
  switch (deployment.manifest.auth.mode) {
    case "microsoft-entra":
      return new MicrosoftEntraDeploymentAuthProvider(deployment)
    case "mentra-account":
      throw new Error("mentra-account workspace auth is not supported in deployment schema v1")
  }
}
