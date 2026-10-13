import {miniappDeveloperPackageName} from "@/constants/miniapps"

import type {ActiveDeployment} from "./types"

/**
 * Miniapp development (the Miniapp Developer tools and the builds they load)
 * follows the deployment's approval of those tools, as the engine's
 * `isMiniappDevelopmentAllowed` does. Super Mode does not override it.
 */
export function isMiniappDevelopmentAllowed(deployment: ActiveDeployment): boolean {
  const approved = deployment.manifest.systemMiniapps.approvedPackageNamesOverride
  return approved === null || approved.includes(miniappDeveloperPackageName)
}
