import {Text} from "@/components/ignite"
import GlassView from "@/components/ui/GlassView"
import {useDefaultMiniappsStore} from "@/stores/defaultMiniapps"

/**
 * Says the deployment's default miniapps will install once online, when the phone doesn't know which they are yet
 * (Core never answered: defaultMiniapps.ts). Once it knows, Home shows each one as if installed instead.
 */
export function MiniappInstallStatus() {
  const listUnknown = useDefaultMiniappsStore((state) => state.status === "waiting" && state.pending.length === 0)
  if (!listUnknown) return null
  return (
    <GlassView className="flex-row items-center gap-3 p-4 bg-primary-foreground" testID="miniapp-install-status">
      <Text tx="home:miniappsWaitingForConnection" className="shrink text-sm text-secondary-foreground" />
    </GlassView>
  )
}
