import {SETTINGS, useSetting} from "@/stores/settings"
import {GlassView as GlassViewComponent, GlassViewProps, isLiquidGlassAvailable} from "expo-glass-effect"
import {Platform, View, ViewProps} from "react-native"
import {withUniwind} from "uniwind"

interface NewGlassViewProps extends ViewProps {
  transparent?: boolean
}

const GlassView = ({children, style, transparent = true, ...props}: GlassViewProps & NewGlassViewProps) => {
  const [iosGlassEffect] = useSetting(SETTINGS.ios_glass_effect.key)
  if (iosGlassEffect && isLiquidGlassAvailable()) {
    if (transparent) {
      return (
        <GlassViewComponent style={[style, {backgroundColor: "transparent"}]} {...props}>
          {children}
        </GlassViewComponent>
      )
    }
    return (
      <GlassViewComponent style={style} {...props}>
        {children}
      </GlassViewComponent>
    )
  }
  if (Platform.OS === "android") {
    return (
      <GlassViewComponent style={style} {...props}>
        {children}
      </GlassViewComponent>
    )
  }
  return (
    <View style={style} {...props}>
      {children}
    </View>
  )
}

export default withUniwind(GlassView)
