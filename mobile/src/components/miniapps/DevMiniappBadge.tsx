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
export function DevMiniappBadge({size = 16}: {size?: number}) {
  return (
    <View
      className="absolute -top-0.5 -right-0.5 bg-orange-500 border border-white"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
      }}
      pointerEvents="none"
    />
  )
}