import {Icon} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {View} from "react-native"

/**
 * Placeholder tile for a dev miniapp that didn't ship an icon. Fills the whole
 * icon slot with a hammer glyph. When the dev miniapp DOES declare an icon we
 * render its real logo instead and only overlay {@link DevMiniappBadge}.
 */
export function DevIcon({size = 24}: {size?: number}) {
  const {theme} = useAppTheme()
  return (
    <View className="absolute flex-1 items-center justify-center bg-foreground z-1" style={{width: size, height: size}}>
      <Icon name="hammer" size={size - 16} color={theme.colors.primary} />
    </View>
  )
}

/**
 * Small orange dot overlaid on a miniapp's icon to mark it as a dev miniapp
 * (loaded via QR scan / dev URL, not from the store). Positioned at the
 * top-right of the icon's bounding box with a white border so it stays visible
 * against any logo.
 *
 * Render this as a SIBLING of the (overflow-hidden) icon container, inside a
 * relatively-positioned wrapper — not inside the squircle, or it gets clipped.
 */
export function DevMiniappBadge({size = 10}: {size?: number}) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: -2,
        right: -2,
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: "#F97316", // tailwind orange-500
        borderWidth: 1.5,
        borderColor: "#fff",
      }}
    />
  )
}
