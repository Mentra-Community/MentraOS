/**
 * Gallery skeleton loading component with shimmer effect
 */

import LinearGradient from "expo-linear-gradient"
import {View, ViewStyle} from "react-native"
import {createShimmerPlaceholder} from "react-native-shimmer-placeholder"

import {spacing, ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

const ShimmerPlaceholder = createShimmerPlaceholder(LinearGradient)

interface GallerySkeletonProps {
  itemCount?: number
  numColumns?: number
  itemWidth?: number
}

export function GallerySkeleton({itemCount = 8, numColumns = 2, itemWidth = 150}: GallerySkeletonProps) {
  const {themed} = useAppTheme()
  const ITEM_SPACING = spacing.s2
  const itemHeight = itemWidth * 0.8 // Match aspect ratio

  return (
    <View style={themed($container)}>
      {Array.from({length: itemCount}).map((_, index) => (
        <View
          key={index}
          style={[
            themed($skeletonItem),
            {
              width: itemWidth,
              marginRight: (index + 1) % numColumns === 0 ? 0 : ITEM_SPACING,
              marginBottom: ITEM_SPACING,
            },
          ]}>
          <ShimmerPlaceholder
            shimmerColors={["#e0e0e0", "#f0f0f0", "#e0e0e0"]}
            shimmerStyle={{
              width: "100%",
              height: itemHeight,
              borderRadius: 8,
            }}
            duration={1500}
            isReversed={index % 2 === 0}
          />
        </View>
      ))}
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  flexWrap: "wrap",
  justifyContent: "space-between",
})

const $skeletonItem: ThemedStyle<ViewStyle> = ({spacing: _spacing}) => ({
  borderRadius: _spacing.s2,
  overflow: "hidden",
})
