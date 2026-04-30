import {useAppTheme} from "@/contexts/ThemeContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {GlassView as GlassViewComponent, GlassViewProps, isLiquidGlassAvailable} from "expo-glass-effect"
import {LinearGradient} from "expo-linear-gradient"
import {Platform, View, ViewProps} from "react-native"
import {withUniwind} from "uniwind"
import {StyleSheet} from "react-native"
interface NewGlassViewProps extends ViewProps {
  transparent?: boolean
}

const GlassWithStyle = withUniwind(GlassViewComponent)

const GlassView = ({children, style, transparent = true, ...props}: GlassViewProps & NewGlassViewProps) => {
  const [iosGlassEffect] = useSetting(SETTINGS.ios_glass_effect.key)
  const {theme} = useAppTheme()
  let boxShadowStyle = "8px 8px 16px 0px rgba(0, 0, 0, 0.06)"
  let colorScheme: "light" | "dark" = theme.isDark ? "dark" : "light"
  if (iosGlassEffect && isLiquidGlassAvailable()) {
    // if you want a view to not be transparent, don't set the transparent flag & add a background color
    // don't just override all transparent views to have a background 😑
    if (transparent) {
      return (
        <GlassWithStyle
          style={[style, {backgroundColor: "transparent", boxShadow: boxShadowStyle}]}
          colorScheme={colorScheme}
          {...props}
          className="shadow-2xl">
          {children}
        </GlassWithStyle>
      )
    }
    return (
      <GlassWithStyle style={[style, {boxShadow: boxShadowStyle}]} colorScheme={colorScheme} {...props}>
        {children}
      </GlassWithStyle>
    )
  }
  if (Platform.OS === "android") {
    // let borderRadius = props.borderRadius ?? 0
    // extract borderTopLeftRadius from style by flattening the style object
    const flatStyle = StyleSheet.flatten(style) || {}
    boxShadowStyle = "8px 8px 16px 0px rgba(0, 0, 0, 0.10)"

    const borderTopLeftRadius = flatStyle.borderTopLeftRadius ?? flatStyle.borderRadius ?? 0
    const borderTopRightRadius = flatStyle.borderTopRightRadius ?? flatStyle.borderRadius ?? 0
    const borderBottomLeftRadius = flatStyle.borderBottomLeftRadius ?? flatStyle.borderRadius ?? 0
    const borderBottomRightRadius = flatStyle.borderBottomRightRadius ?? flatStyle.borderRadius ?? 0
    return (
      <GlassWithStyle style={[style, {boxShadow: boxShadowStyle}]} colorScheme={colorScheme} {...props}>
        <LinearGradient
          colors={[theme.colors.gradient, flatStyle.backgroundColor ?? theme.colors.primary_foreground]}
          start={{x: 0, y: 0}}
          end={{x: 0.5, y: 0.5}}
          style={{
            ...StyleSheet.absoluteFill,
            borderTopLeftRadius: borderTopLeftRadius,
            borderTopRightRadius: borderTopRightRadius,
            borderBottomLeftRadius: borderBottomLeftRadius,
            borderBottomRightRadius: borderBottomRightRadius,
          }}
        />
        {children}
      </GlassWithStyle>
    )
  }
  return (
    <View style={[style, {boxShadow: boxShadowStyle}]} {...props}>
      {children}
    </View>
  )
}

export default withUniwind(GlassView)
