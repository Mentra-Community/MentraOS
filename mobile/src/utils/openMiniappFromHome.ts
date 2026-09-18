import {engine, type ClientApp} from "@mentra/engine"

import {isOfflineHosted} from "@/components/miniapp/offlineHostedPackages"
import {useNavigationStore} from "@/stores/navigation"
import {blockUpdatingMiniapp} from "@/utils/miniappUpdatingAlert"

/** Foreground only an accepted launch; a blocked tap must leave Home intact. */
export async function openMiniappFromHome(app: ClientApp): Promise<boolean> {
  if (blockUpdatingMiniapp(app.packageName)) return false
  const started = await engine.miniapps.start(app, {skipNavigation: true})
  if (!started || blockUpdatingMiniapp(app.packageName)) return false

  if (app.local || isOfflineHosted(app.packageName)) {
    await engine.miniapps.setForeground(app.packageName)
  } else if (app.offlineRoute) {
    useNavigationStore.getState().push(app.offlineRoute, {transition: "fade"})
  }
  return true
}
