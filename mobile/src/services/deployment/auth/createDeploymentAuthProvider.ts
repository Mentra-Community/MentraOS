import type {WorkspaceDeployment} from "@/services/deployment/types"
import type {DeploymentAuthProvider} from "./DeploymentAuthProvider"
import {MicrosoftEntraDeploymentAuthProvider} from "./MicrosoftEntraDeploymentAuthProvider"

export function createDeploymentAuthProvider(deployment: WorkspaceDeployment): DeploymentAuthProvider {
  switch (deployment.manifest.auth.mode) {
    case "microsoft-entra":
      return new MicrosoftEntraDeploymentAuthProvider(deployment)
    case "mentra-account":
      throw new Error("mentra-account workspace auth is not supported in deployment schema v1")
  }
}
