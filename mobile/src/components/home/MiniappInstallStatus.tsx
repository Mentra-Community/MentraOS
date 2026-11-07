import {ActivityIndicator} from "react-native"

import {Text} from "@/components/ignite"
import GlassView from "@/components/ui/GlassView"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useDefaultMiniappsStore} from "@/stores/defaultMiniapps"

/** The deployment's default miniapps that are installing, or waiting for a connection to install (defaultMiniapps.ts). */
export function MiniappInstallStatus() {
  const {theme} = useAppTheme()
  const {status, pending} = useDefaultMiniappsStore()
  if (status === "idle") return null
  const installing = status === "installing"
  return (
    <GlassView className="flex-row items-center gap-3 p-4 bg-primary-foreground" testID="miniapp-install-status">
      {installing && <ActivityIndicator size="small" color={theme.colors.secondary_foreground} />}
      <Text
        tx={installing ? "home:miniappsInstalling" : "home:miniappsWaitingForConnection"}
        txOptions={{count: pending.length}}
        className="shrink text-sm text-secondary-foreground"
      />
    </GlassView>
  )
}
