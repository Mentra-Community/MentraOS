import {View} from "react-native"

import {SETTINGS, useSetting} from "@mentra/engine"

import ToggleSetting from "@/components/settings/ToggleSetting"
import {Text} from "@/components/ignite"
import {translate} from "@/i18n"

/**
 * Mentra Live glasses-mic gates:
 * VAD is temporarily forced off by both Mentra Live SGCs; restore its toggle
 * when their FORCE_DISABLE_VAD flags are removed.
 * - Barrier: cs_swit type 10 (center-mic loudness / RMS)
 */
export function MicrophoneGateSettings() {
  const [loudnessGate, setLoudnessGate] = useSetting<boolean>(SETTINGS.loudness_gate_enabled.key)

  return (
    <View className="gap-3">
      <Text tx="microphoneSettings:glassesMicGates" className="text-text text-base font-semibold" />
      <ToggleSetting
        label={translate("microphoneSettings:barrierLabel")}
        subtitle={translate("microphoneSettings:barrierSubtitle")}
        value={loudnessGate}
        onValueChange={(enabled) => {
          void setLoudnessGate(enabled)
        }}
        isFirst
        isLast
      />
    </View>
  )
}
