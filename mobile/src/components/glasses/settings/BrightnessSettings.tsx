import {useState, useEffect} from "react"
import {ViewStyle} from "react-native"

import SliderSetting from "@/components/settings/SliderSetting"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {translate} from "@/i18n"

interface BrightnessSettingsProps {
  autoBrightness: boolean
  brightness: number
  onAutoBrightnessChange: (value: boolean) => void
  onBrightnessChange: (value: number) => void
  style?: ViewStyle
}

export function BrightnessSettings({
  autoBrightness,
  brightness,
  onAutoBrightnessChange,
  onBrightnessChange,
  style: _style,
}: BrightnessSettingsProps) {
  const [tempBrightness, setTempBrightness] = useState(brightness)

  // Sync local state when brightness prop changes
  useEffect(() => {
    setTempBrightness(brightness)
  }, [brightness])

  return (
    <>
      <ToggleSetting
        label={translate("deviceSettings:autoBrightness")}
        value={autoBrightness}
        onValueChange={onAutoBrightnessChange}
      />

      {!autoBrightness && (
        <SliderSetting
          label={translate("deviceSettings:brightness")}
          value={tempBrightness}
          onValueChange={setTempBrightness}
          min={0}
          max={100}
          onValueSet={onBrightnessChange}
          containerStyle={{paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0}}
          disableBorder
        />
      )}
    </>
  )
}
