import {useEffect, useRef} from "react"
import {Platform, View} from "react-native"

import {SETTINGS, useSetting} from "@/stores/settings"
import {useGlassesStore} from "@/stores/glasses"
import {usePathname} from "expo-router"
import {DeviceTypes} from "@/../../cloud/packages/types/src"
import showAlert from "@/utils/AlertUtils"
import {translate} from "@/i18n"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppletStatusStore, useLocalMiniApps} from "@/stores/applets"
import {Text} from "@/components/ignite"

// render the webviews of any local mini apps:
export function LocalMiniApps() {
  // const miniApps = useAppletStatusStore.getState().apps.filter((app) => app.offline)

  const localMiniApps = useLocalMiniApps()

  // render a 10px x 10px view for each local mini app:
  return localMiniApps.map((app) => (
    <View key={app.packageName} className="w-10 h-10 bg-red-500">
      <Text>{app.name}</Text>
    </View>
  ))

  return null
}
