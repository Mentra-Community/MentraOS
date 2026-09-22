import {TouchableOpacity, View} from "react-native"

import {Text} from "@/components/ignite"
import GlassView from "@/components/ui/GlassView"

type Props = {
  label: string
  subtitle?: string
  onPress: () => void
  /** Ignore taps while a previous command is still in flight. */
  disabled?: boolean
}

/**
 * Settings action that is not RouteButton. RouteButton's chevron chrome inside
 * GlassView often looks tappable in the Super Mode overlay but never fires;
 * wrap GlassView in TouchableOpacity so the press belongs to the action.
 */
export function SettingsCommandButton({label, subtitle, onPress, disabled = false}: Props) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityState={{disabled}}
      style={disabled ? {opacity: 0.5} : undefined}>
      <GlassView
        pointerEvents="none"
        androidShadowSize="sm"
        className="bg-primary-foreground px-4 py-4 rounded-2xl">
        <View className="gap-1">
          <Text text={label} className="text-sm font-semibold text-foreground" />
          {subtitle ? <Text text={subtitle} className="text-xs text-muted-foreground" /> : null}
        </View>
      </GlassView>
    </TouchableOpacity>
  )
}
