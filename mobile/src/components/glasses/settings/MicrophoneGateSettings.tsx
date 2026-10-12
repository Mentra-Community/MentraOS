import {View} from "react-native"

import {SETTINGS, useSetting} from "@mentra/engine"

import ToggleSetting from "@/components/settings/ToggleSetting"
import {Text} from "@/components/ignite"
import {translate} from "@/i18n"

/**
 * Mentra Live glasses-mic gates:
 * - Allow VAD: user permission for cs_swit type 8 (GX8002), resolved by MicStateCoordinator
 * - Barrier: cs_swit type 10 (center-mic loudness / RMS)
 */
export function MicrophoneGateSettings() {
  const [vadAllowed, setVadAllowed] = useSetting<boolean>(SETTINGS.voice_activity_detection_enabled.key)
  const [loudnessGate, setLoudnessGate] = useSetting<boolean>(SETTINGS.loudness_gate_enabled.key)

  return (
    <View className="gap-3">
      <Text tx="microphoneSettings:glassesMicGates" className="text-text text-base font-semibold" />
      <ToggleSetting
        label={translate("microphoneSettings:vadLabel")}
        value={vadAllowed}
        onValueChange={(allowed) => {
          void setVadAllowed(allowed)
        }}
        isFirst
      />
      <ToggleSetting
        label={translate("microphoneSettings:barrierLabel")}
        subtitle={translate("microphoneSettings:barrierSubtitle")}
        value={loudnessGate}
        onValueChange={(enabled) => {
          void setLoudnessGate(enabled)
        }}
        isLast
      />
    </View>
  )
}
