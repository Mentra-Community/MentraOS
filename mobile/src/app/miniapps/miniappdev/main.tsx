import {useRef} from "react"
import {View} from "react-native"

import {Screen} from "@/components/ignite"
import {Group} from "@/components/ui"
import {RouteButton} from "@/components/ui/RouteButton"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n/translate"
import {useRegisterCapsule} from "@/stores/capsule"

export default function MiniappDevMain() {
  const viewShotRef = useRef<View>(null)
  const {push} = useNavigationStore.getState()

  useRegisterCapsule({
    packageName: "com.mentra.miniappdev",
    viewShotRef,
    visibleOnRoutes: ["/miniapps/miniappdev/"],
  })

  return (
    <Screen preset="fixed" safeAreaEdges={["top"]} ref={viewShotRef}>
      <View className="h-24" />

      <Group>
        <RouteButton
          label={translate("debugSettings:miniappDevLoadUrlLabel")}
          subtitle={translate("debugSettings:miniappDevLoadUrlSubtitle")}
          onPress={() => push("/miniapps/miniappdev/developer-url")}
        />
        <RouteButton
          label={translate("debugSettings:miniappDevScanLabel")}
          subtitle={translate("debugSettings:miniappDevScanSubtitle")}
          onPress={() => push("/miniapps/miniappdev/scanner")}
        />
      </Group>
    </Screen>
  )
}
