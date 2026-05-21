import {useRef} from "react"
import {View} from "react-native"

import {Screen} from "@/components/ignite"
import {Group} from "@/components/ui"
import {RouteButton} from "@/components/ui/RouteButton"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n/translate"
import {SETTINGS, useSetting} from "@/stores/settings"
import {useRegisterCapsule} from "@/stores/capsule"

export default function MiniappDevMain() {
  const viewShotRef = useRef<View>(null)
  const {push} = useNavigationStore.getState()
  const [localSttFallbackEnabled, setLocalSttFallbackEnabled] = useSetting(SETTINGS.local_stt_fallback_enabled.key)

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
          label={translate("devSettings:miniappDevLoadUrlLabel")}
          subtitle={translate("devSettings:miniappDevLoadUrlSubtitle")}
          onPress={() => push("/miniapps/miniappdev/developer-url")}
        />
        <RouteButton
          label={translate("devSettings:miniappDevScanLabel")}
          subtitle={translate("devSettings:miniappDevScanSubtitle")}
          onPress={() => push("/miniapps/miniappdev/scanner")}
        />
        <ToggleSetting
          label="Local STT Fallback"
          subtitle="Use on-device Sherpa when cloud transcription fails (requires downloaded language pack)"
          value={localSttFallbackEnabled}
          onValueChange={(value) => setLocalSttFallbackEnabled(value)}
        />
      </Group>
    </Screen>
  )
}
