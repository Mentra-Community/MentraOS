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
export function DevMiniappBadge({size = 10}: {size?: number}) {
  return (
    <View
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
      pointerEvents="none"
    />
  )
}

/** Convenience style for an icon container that hosts the badge. */
export const $devMiniappIconContainer: ViewStyle = {
  position: "relative",
}
