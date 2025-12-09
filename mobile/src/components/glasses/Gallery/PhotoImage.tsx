/**
 * PhotoImage component that handles AVIF and other image formats
 * Shows a placeholder for AVIF files since React Native doesn't support them natively
 */

import LinearGradient from "expo-linear-gradient"
import {useState, useEffect} from "react"
import {View, Image} from "react-native"
import {ViewStyle, ImageStyle, TextStyle} from "react-native"
import {createShimmerPlaceholder} from "react-native-shimmer-placeholder"

import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {PhotoInfo} from "@/types/asg"
import {useAppTheme} from "@/utils/useAppTheme"

// @ts-ignore
const ShimmerPlaceholder = createShimmerPlaceholder(LinearGradient)

interface PhotoImageProps {
  photo: PhotoInfo
  style?: ImageStyle
  showPlaceholder?: boolean
}

export function PhotoImage({photo, style, showPlaceholder = true}: PhotoImageProps) {
  const {theme, themed} = useAppTheme()
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [isAvif, setIsAvif] = useState(false)

  // Determine the image URL to use:
  // 1. For synced videos, use thumbnailPath if available
  // 2. For server videos, use thumbnail_data if available (base64 data URL)
  // 3. Otherwise use the main URL
  // Note: Relative URLs (starting with /) are from server during sync and won't load
  const imageUrl = (() => {
    if (photo.is_video) {
      if (photo.thumbnailPath) {
        return photo.thumbnailPath
      }
      if (photo.thumbnail_data) {
        // thumbnail_data might already be a data URL or just base64
        return photo.thumbnail_data.startsWith("data:")
          ? photo.thumbnail_data
          : `data:image/jpeg;base64,${photo.thumbnail_data}`
      }
    }
    return photo.url
  })()

  // If URL is a relative path (from server during sync), show shimmer placeholder
  // These URLs won't work without the server base URL, so don't attempt to load them
  const isRelativeUrl = imageUrl?.startsWith("/")
  if (isRelativeUrl && showPlaceholder) {
    const imageStyle = style as ViewStyle
    return (
      <ShimmerPlaceholder
        shimmerColors={[theme.colors.border, theme.colors.background, theme.colors.border]}
        shimmerStyle={{
          width: imageStyle?.width || "100%",
          height: imageStyle?.height || imageStyle?.width || 100,
          borderRadius: 0,
        }}
        duration={1500}
      />
    )
  }

  useEffect(() => {
    // For local files (file:// URLs), skip async validation and load immediately
    // Trust our storage system since these are downloaded files we manage
    if (imageUrl.startsWith("file://")) {
      // Check if it's AVIF by mime type or filename
      if (photo.mime_type === "image/avif" || !photo.name.includes(".") || photo.name.match(/\.(avif|avifs)$/i)) {
        setIsAvif(true)
      }
      setIsLoading(false)
      return
    }

    // For remote files, do full async validation
    const checkFileAndFormat = async () => {
      // Check by mime type
      if (photo.mime_type === "image/avif") {
        setIsAvif(true)
        setIsLoading(false)
        return
      }

      // Check by filename (files without extensions might be AVIF)
      if (!photo.name.includes(".") || photo.name.match(/\.(avif|avifs)$/i)) {
        setIsAvif(true)
        setIsLoading(false)
        return
      }

      // Check if the URL returns AVIF data
      if (imageUrl.includes("application/octet-stream") || imageUrl.includes("image/avif")) {
        setIsAvif(true)
        setIsLoading(false)
        return
      }

      setIsLoading(false)
    }

    checkFileAndFormat()
  }, [photo, imageUrl])

  const handleLoadEnd = () => {
    setIsLoading(false)
  }

  const handleError = (error: any) => {
    // Extract error message safely without passing complex circular objects
    const errorMessage = error?.nativeEvent?.error || error?.message || String(error)
    console.error("[PhotoImage] Error loading image:", {
      name: photo.name,
      url: imageUrl,
      isVideo: photo.is_video,
      error: errorMessage,
    })
    setHasError(true)
    setIsLoading(false)
    // Might be AVIF if regular loading failed
    if (!photo.name.match(/\.(jpg|jpeg|png|gif|webp|bmp)$/i)) {
      setIsAvif(true)
    }
  }

  // Show AVIF placeholder
  if (isAvif && showPlaceholder) {
    return (
      <View style={[themed($placeholderContainer), style as ViewStyle]}>
        <View style={themed($avifBadge)}>
          <Text style={themed($avifBadgeText)}>AVIF</Text>
        </View>
        <Text style={themed($placeholderText)}>📷</Text>
        <Text style={themed($placeholderSubtext)}>
          {photo.name.length > 15 ? photo.name.substring(0, 12) + "..." : photo.name}
        </Text>
      </View>
    )
  }

  // Show error placeholder as shimmer
  if (hasError && showPlaceholder) {
    const imageStyle = style as ViewStyle
    return (
      <ShimmerPlaceholder
        shimmerColors={[theme.colors.border, theme.colors.background, theme.colors.border]}
        shimmerStyle={{
          width: imageStyle?.width || "100%",
          height: imageStyle?.height || imageStyle?.width || 100,
          borderRadius: 0,
        }}
        duration={1500}
      />
    )
  }

  // URL determined and ready to use

  return (
    <View style={style as ViewStyle}>
      {isLoading && <View style={[themed($loadingOverlay), style as ViewStyle]} />}
      <Image
        source={{uri: imageUrl}}
        style={[style, isLoading && {opacity: 0}]}
        onLoadEnd={handleLoadEnd}
        onError={handleError}
        resizeMode="cover"
      />
    </View>
  )
}

const $placeholderContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.palette.neutral200,
  justifyContent: "center",
  alignItems: "center",
  padding: spacing.s3,
  position: "relative",
})

const $avifBadge: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  position: "absolute",
  top: spacing.s2,
  right: spacing.s2,
  backgroundColor: colors.palette.primary500,
  paddingHorizontal: spacing.s2,
  paddingVertical: 2,
  borderRadius: 4,
})

const $avifBadgeText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 10,
  fontWeight: "bold",
  color: colors.background,
})

const $placeholderText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 32,
  color: colors.textDim,
})

const $placeholderSubtext: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 11,
  color: colors.textDim,
  marginTop: spacing.s2,
  textAlign: "center",
})

const $loadingOverlay: ThemedStyle<ViewStyle> = ({colors}) => ({
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: colors.palette.neutral300, // Darker, less jarring than neutral100
  zIndex: 1,
})
