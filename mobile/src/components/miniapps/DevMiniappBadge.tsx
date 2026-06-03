import {Icon} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {View, ViewStyle} from "react-native"

/**
 * Small orange dot rendered over a miniapp's icon to indicate it's a dev
 * miniapp (loaded via QR scan / dev URL, not from the store). Position is
 * top-right of the icon's bounding box.
 *
 * Caller is responsible for placing this inside a relatively-positioned
 * container that wraps the icon. The dot is absolutely-positioned within
 * that container.
 */
export function DevMiniappBadge({size = 24}: {size?: number}) {
  const {theme} = useAppTheme()
  return (
    <View
      className="absolute -top-1 -right-1 bg-chart-5 border border-black rounded-full items-center justify-center"
      style={{width: size, height: size}}>
      <Icon name="user-code" size={20} color={theme.colors.primary_foreground} />
    </View>
  )
}
