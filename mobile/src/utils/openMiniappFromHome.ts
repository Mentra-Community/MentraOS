import {engine, type ClientApp} from "@mentra/engine"

import {isOfflineHosted} from "@/components/miniapp/offlineHostedPackages"
import {setMiniappOpeningAnimation} from "@/stores/miniappLaunch"
import {useNavigationStore} from "@/stores/navigation"
import {blockUpdatingMiniapp} from "@/utils/miniappUpdatingAlert"

/** Foreground only an accepted launch; a blocked tap must leave Home intact. */
export async function openMiniappFromHome(app: ClientApp, animation: "slide" | "expand" = "slide"): Promise<boolean> {
  if (blockUpdatingMiniapp(app.packageName)) return false
  const started = await engine.miniapps.start(app, {skipNavigation: true})
  if (!started || blockUpdatingMiniapp(app.packageName)) return false

  if (app.local || isOfflineHosted(app.packageName)) {
    if (!engine.miniapps.list().some((item) => item.packageName === app.packageName && item.foregrounded)) {
      setMiniappOpeningAnimation(app.packageName, animation)
    }
    await engine.miniapps.setForeground(app.packageName)
  } else if (app.offlineRoute) {
    useNavigationStore.getState().push(app.offlineRoute, {transition: "fade"})
  }
  return true
}
