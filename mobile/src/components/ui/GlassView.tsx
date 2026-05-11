import {useAppTheme} from "@/contexts/ThemeContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {GlassView as GlassViewComponent, GlassViewProps, isLiquidGlassAvailable} from "expo-glass-effect"
import {LinearGradient} from "expo-linear-gradient"
import {Platform, View, ViewProps, StyleSheet} from "react-native"
import {withUniwind} from "uniwind"
import {ShadowView} from "react-native-inner-shadow"
interface NewGlassViewProps extends ViewProps {
  transparent?: boolean
  disableOnAndroid?: boolean
  androidShadowSize?: AndroidShadowSize
}

type AndroidShadowSize = "sm" | "md" | "lg"

const GlassWithStyle = withUniwind(GlassViewComponent)

const GlassView = ({
  children,
  style,
  transparent = true,
  disableOnAndroid = false,
  androidShadowSize = "lg",
  ...props
}: GlassViewProps & NewGlassViewProps) => {
  const [iosGlassEffect] = useSetting(SETTINGS.ios_glass_effect.key)
  const [androidInnerShadow] = useSetting(SETTINGS.android_inner_shadow.key)
  
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
  if (Platform.OS === "android" && !disableOnAndroid) {
    // let borderRadius = props.borderRadius ?? 0
    // extract borderTopLeftRadius from style by flattening the style object
    const flatStyle = StyleSheet.flatten(style) || {}
    // boxShadowStyle = "8px 8px 16px 0px rgba(0, 0, 0, 0.10)"

    const borderTopLeftRadius = flatStyle.borderTopLeftRadius ?? flatStyle.borderRadius ?? 0
    const borderTopRightRadius = flatStyle.borderTopRightRadius ?? flatStyle.borderRadius ?? 0
    const borderBottomLeftRadius = flatStyle.borderBottomLeftRadius ?? flatStyle.borderRadius ?? 0
    const borderBottomRightRadius = flatStyle.borderBottomRightRadius ?? flatStyle.borderRadius ?? 0
    const borderRadius = flatStyle.borderRadius ?? 0
    // 55% transparent theme.colors.primary_foreground
    let backgroundColor = theme.colors.primary_foreground + "C9"
    backgroundColor = flatStyle.backgroundColor?.toString() ?? backgroundColor

    // boxShadowStyle = "4px 4px 16px 0px rgba(0, 0, 0, 0.10)"
    if (androidShadowSize === "sm") {
      boxShadowStyle = "3px 3px 4px 0px rgba(0, 0, 0, 0.1)"
    } else if (androidShadowSize === "md") {
      boxShadowStyle = "4px 4px 16px 0px rgba(0, 0, 0, 0.10)"
    } else if (androidShadowSize === "lg") {
      boxShadowStyle = "4px 4px 16px 0px rgba(0, 0, 0, 0.10)"
    }

    if (!androidInnerShadow) {
      return (
        <View
          style={[
            style,
            {
              backgroundColor: backgroundColor,
              boxShadow: boxShadowStyle,
              // borderTopLeftRadius,
              // borderTopRightRadius,
              // borderBottomLeftRadius,
              // borderBottomRightRadius,
            },
          ]}>
          {children}
        </View>
      )
    }
    // let maxBorderRadius = Math.max(
    //   parseInt(borderTopLeftRadius.toString()),
    //   parseInt(borderTopRightRadius.toString()),
    //   parseInt(borderBottomLeftRadius.toString()),
    //   parseInt(borderBottomRightRadius.toString()),
    // )
    const halve = (v: string | number | undefined) => (v === undefined ? undefined : parseInt(v.toString()) / 2)
    let innerShadowColor = theme.colors.gradient

    return (
      <ShadowView
        inset
        shadowColor={innerShadowColor + "AA"}
        // shadowBlur={16}
        // shadowOffset={{width: 8, height: 8}}
        style={[
          style,
          {
            borderWidth: 1.25,
            borderColor: theme.colors.background,
            borderRadius: borderRadius,
            backgroundColor: backgroundColor,
            borderTopLeftRadius,
            borderTopRightRadius,
            borderBottomLeftRadius,
            borderBottomRightRadius,
            boxShadow: boxShadowStyle,
          },
        ]}>
        {children}
      </ShadowView>
    )

    // let innerShadowColor = "#00ff00"
    return (
      <View
        style={{
          borderWidth: 1.25,
          borderColor: theme.colors.background,
          // borderColor: "#000fff",
          borderRadius: borderRadius,
          borderTopLeftRadius,
          borderTopRightRadius,
          borderBottomLeftRadius,
          borderBottomRightRadius,
          marginLeft: flatStyle.marginLeft ?? undefined,
          marginRight: flatStyle.marginRight ?? undefined,
          marginTop: flatStyle.marginTop ?? undefined,
          marginBottom: flatStyle.marginBottom ?? undefined,
          marginVertical: flatStyle.marginVertical ?? undefined,
          marginHorizontal: flatStyle.marginHorizontal ?? undefined,
          // flex: flatStyle.flex ?? undefined,
          // flexDirection: flatStyle.flexDirection ?? undefined,
          // flexWrap: flatStyle.flexWrap ?? undefined,
          // flexGrow: flatStyle.flexGrow ?? undefined,
          // flexShrink: flatStyle.flexShrink ?? undefined,
          // flexBasis: flatStyle.flexBasis ?? undefined,
          // justifyContent: flatStyle.justifyContent ?? undefined,
          // alignContent: flatStyle.alignContent ?? undefined,
          // alignItems: flatStyle.alignItems ?? undefined,
          // alignSelf: flatStyle.alignSelf ?? undefined,
          // width: flatStyle.width ?? undefined,
          // minWidth: flatStyle.minWidth ?? undefined,
          // maxWidth: flatStyle.maxWidth ?? undefined,
          // height: flatStyle.height ?? undefined,
          // minHeight: flatStyle.minHeight ?? undefined,
          // maxHeight: flatStyle.maxHeight ?? undefined,
          // ...flatStyle,
          boxShadow: boxShadowStyle,
        }}>
        <View
          style={[
            // style,
            {
              // boxShadow: boxShadowStyle,
              // borderRadius: maxBorderRadius,
              // borderWidth: 5,
              // borderColor: theme.colors.background,
              height: flatStyle.height ?? undefined,
              width: flatStyle.width ?? undefined,
              minHeight: flatStyle.minHeight ?? undefined,
              minWidth: flatStyle.minWidth ?? undefined,
              maxHeight: flatStyle.maxHeight ?? undefined,
              maxWidth: flatStyle.maxWidth ?? undefined,
              borderRadius: borderRadius,
              borderTopLeftRadius,
              borderTopRightRadius,
              borderBottomLeftRadius,
              borderBottomRightRadius,
              // backgroundColor: "red",
            },
          ]}>
          <ShadowView
            inset
            shadowColor={innerShadowColor + "AA"}
            // reflectedLightBlur={100}
            // shadowOffset={{width: 30, height: 30}}
            // shadowBlur={40}
            // shadowOffset={{width: 8, height: 8}}
            // shadowRadius={100}
            // boxShadow={boxShadowStyle}
            style={[
              style,
              {
                // boxShadow: boxShadowStyle,
                borderTopLeftRadius,
                borderTopRightRadius,
                borderBottomLeftRadius,
                borderBottomRightRadius,
                // margin: halve(flatStyle.margin?.toString()),
                // marginLeft: halve(flatStyle.marginLeft?.toString()),
                // marginRight: halve(flatStyle.marginRight?.toString()),
                // marginTop: halve(flatStyle.marginTop?.toString()),
                // marginBottom: halve(flatStyle.marginBottom?.toString()),
                // marginVertical: halve(flatStyle.marginVertical?.toString()),
                // marginHorizontal: halve(flatStyle.marginHorizontal?.toString()),
                paddingVertical: halve(flatStyle.paddingVertical?.toString()),
                paddingHorizontal: halve(flatStyle.paddingHorizontal?.toString()),
                paddingLeft: halve(flatStyle.paddingLeft?.toString()),
                paddingRight: halve(flatStyle.paddingRight?.toString()),
                paddingTop: halve(flatStyle.paddingTop?.toString()),
                paddingBottom: halve(flatStyle.paddingBottom?.toString()),
                padding: halve(flatStyle.padding?.toString()),
                // margin: 0,
                // padding: 0,
                // height: flatStyle.height ?? undefined,
                // width: flatStyle.width ?? undefined,
                justifyContent: flatStyle.justifyContent ?? undefined,
                alignItems: flatStyle.alignItems ?? undefined,
                alignSelf: flatStyle.alignSelf ?? undefined,
                alignContent: flatStyle.alignContent ?? undefined,
                flexDirection: flatStyle.flexDirection ?? undefined,
                flexWrap: flatStyle.flexWrap ?? undefined,
                flexGrow: flatStyle.flexGrow ?? undefined,
                flexShrink: flatStyle.flexShrink ?? undefined,
                flexBasis: flatStyle.flexBasis ?? undefined,
                flex: flatStyle.flex ?? undefined,
                // width: "100%",
                // height: "100%",
              },
              // {backgroundColor: backgroundColor},
              // {backgroundColor: "red"},
            ]}>
            {children}
          </ShadowView>
        </View>
      </View>
    )
    // return (
    //   <GlassWithStyle style={[style, {boxShadow: boxShadowStyle}]} colorScheme={colorScheme} {...props}>
    //     {/* <LinearGradient
    //       colors={[theme.colors.gradient, flatStyle.backgroundColor ?? backgroundColor]}
    //       start={{x: 0, y: 0}}
    //       end={{x: 0.5, y: 0.5}}
    //       style={{
    //         ...StyleSheet.absoluteFill,
    //         borderTopLeftRadius: borderTopLeftRadius,
    //         borderTopRightRadius: borderTopRightRadius,
    //         borderBottomLeftRadius: borderBottomLeftRadius,
    //         borderBottomRightRadius: borderBottomRightRadius,
    //       }}
    //     /> */}
    //     <ShadowView
    //       inset
    //       backgroundColor="#f0f0f0"
    //       shadowColor="#00000066"
    //       // shadowOffset={{width: 3, height: 3}}
    //       shadowBlur={5}
    //       style={style}>
    //       {children}
    //     </ShadowView>
    //   </GlassWithStyle>
    // )
  }
  return (
    <View style={[style, {boxShadow: boxShadowStyle}]} {...props}>
      {children}
    </View>
  )
}

export default withUniwind(GlassView)
