import type {OrganizationDeployment} from "@/services/deployment/types"
import type {DeploymentAuthProvider} from "./DeploymentAuthProvider"
import {MicrosoftEntraDeploymentAuthProvider} from "./MicrosoftEntraDeploymentAuthProvider"

export function createDeploymentAuthProvider(deployment: OrganizationDeployment): DeploymentAuthProvider {
  switch (deployment.manifest.auth.mode) {
    case "microsoft-entra":
      return new MicrosoftEntraDeploymentAuthProvider(deployment)
    case "mentra-account":
      throw new Error("mentra-account organization auth is not supported in deployment schema v1")
  }
}
