/**
 * AwesomeGalleryViewer - Unified gallery for images and videos
 * Uses react-native-awesome-gallery for buttery-smooth 60fps swiping
 */

import Slider from "@react-native-community/slider"
import {Image} from "expo-image"
import {useState, useRef, useEffect, useCallback, useMemo, memo, type ElementRef} from "react"
// eslint-disable-next-line no-restricted-imports
import {View, TouchableOpacity, Modal, StatusBar, Text, Dimensions} from "react-native"
import Gallery, {GalleryRef} from "react-native-awesome-gallery"
import {useSafeAreaInsets} from "react-native-safe-area-context"
import MaterialCommunityIcons from "react-native-vector-icons/MaterialCommunityIcons"
import Video from "react-native-video"

import {useAppTheme} from "@/contexts/ThemeContext"
import {ThemedStyle} from "@/theme"
import {PhotoInfo} from "@/types/asg"

const {width: SCREEN_WIDTH, height: SCREEN_HEIGHT} = Dimensions.get("window")

interface AwesomeGalleryViewerProps {
  visible: boolean
  photos: PhotoInfo[]
  initialIndex: number
  onClose: () => void
  onShare?: () => void
}

interface VideoPlayerItemProps {
  photo: PhotoInfo
  isActive: boolean
}

interface ImageItemProps {
  photo: PhotoInfo
  setImageDimensions: (dimensions: {width: number; height: number}) => void
  isActive: boolean // Whether this is the currently visible image
}

/**
 * Video player component for gallery items
 */
const VideoPlayerItem = memo(function VideoPlayerItem({photo, isActive}: VideoPlayerItemProps) {
  const {themed} = useAppTheme()
  const videoRef = useRef<ElementRef<typeof Video>>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isSeeking, setIsSeeking] = useState(false)
  const [hasError, setHasError] = useState(false)
  const [errorMessage, setErrorMessage] = useState("")
  const [isBuffering, setIsBuffering] = useState(true)
  const [showThumbnail, setShowThumbnail] = useState(true)
  const wasInactiveRef = useRef(false)
  const userPausedRef = useRef(false) // Track if user manually paused

  // Auto-play when this video becomes active, restart from beginning if returning
  useEffect(() => {
    if (isActive) {
      console.log("🎥 [VideoPlayerItem] Video became active:", photo.name)

      // If video was previously inactive (user swiped away and came back), restart from beginning
      if (wasInactiveRef.current) {
        console.log("🎥 [VideoPlayerItem] Returning to video - restarting from beginning")
        videoRef.current?.seek(0)
        setCurrentTime(0)
        userPausedRef.current = false // Reset user pause flag when returning
        setIsPlaying(true)
        setShowControls(true)
        wasInactiveRef.current = false
      } else if (!userPausedRef.current) {
        // Only auto-play if user hasn't manually paused
        // First time activation - auto-play unless video is at the end
        if (!(duration > 0 && currentTime >= duration - 0.5)) {
          console.log("🎥 [VideoPlayerItem] Starting playback (video not finished)")
          setIsPlaying(true)
        } else {
          console.log("🎥 [VideoPlayerItem] Video already finished, not auto-playing")
          setShowControls(true)
        }
      } else {
        console.log("🎥 [VideoPlayerItem] User paused - respecting pause state")
      }
    } else {
      console.log("🎥 [VideoPlayerItem] Video became inactive, pausing:", photo.name)
      setIsPlaying(false)
      userPausedRef.current = false // Reset user pause when leaving
      wasInactiveRef.current = true // Mark that this video was deactivated
    }
  }, [isActive, photo.name, duration, currentTime])

  // Hide controls after 3 seconds
  useEffect(() => {
    if (showControls && isPlaying && isActive) {
      const timer = setTimeout(() => setShowControls(false), 3000)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [showControls, isPlaying, isActive])

  const videoUrl = photo.download || photo.url

  // Use thumbnail for poster to show something while loading
  const posterUrl = photo.thumbnailPath
    ? photo.thumbnailPath
    : photo.thumbnail_data
      ? photo.thumbnail_data.startsWith("data:")
        ? photo.thumbnail_data
        : `data:image/jpeg;base64,${photo.thumbnail_data}`
      : undefined

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, "0")}`
  }

  return (
    <View style={themed($videoPlayerContainer)}>
      <Video
        ref={videoRef}
        source={{uri: videoUrl}}
        poster={posterUrl}
        posterResizeMode="contain"
        style={themed($video)}
        resizeMode="contain"
        paused={!isPlaying}
        controls={false}
        repeat={false}
        playInBackground={false}
        playWhenInactive={false}
        ignoreSilentSwitch="ignore"
        progressUpdateInterval={250}
        bufferConfig={{
          minBufferMs: 1500,
          maxBufferMs: 5000,
          bufferForPlaybackMs: 500,
          bufferForPlaybackAfterRebufferMs: 1000,
        }}
        onProgress={({currentTime: time}) => {
          if (!isSeeking) {
            setCurrentTime(time)
          }
        }}
        onLoad={({duration: dur}) => {
          console.log("🎥 [VideoPlayerItem] Video loaded, duration:", dur)
          setDuration(dur)
          setHasError(false)
        }}
        onBuffer={({isBuffering: buffering}) => {
          console.log("🎥 [VideoPlayerItem] Buffering state:", buffering)
          setIsBuffering(buffering)
        }}
        onReadyForDisplay={() => {
          console.log("🎥 [VideoPlayerItem] Video ready for display, hiding thumbnail:", photo.name)
          setIsBuffering(false)
          setShowThumbnail(false)
        }}
        onError={(error) => {
          console.error("🎥 [VideoPlayerItem] Video error:", error)
          const errorStr = String(error?.error?.errorString || error?.error?.code || "Unknown error")
          const isCorrupted = errorStr.includes("UNSUPPORTED") || errorStr.includes("PARSING")
          setHasError(true)
          setErrorMessage(isCorrupted ? "Video file corrupted or unsupported format" : "Failed to play video")
          setIsPlaying(false)
          setIsBuffering(false)
        }}
        onEnd={() => {
          console.log("🎥 [VideoPlayerItem] Video playback ended:", photo.name)
          setIsPlaying(false)
          setShowControls(true)
          // Keep video at end position (don't auto-restart)
        }}
        onSeek={() => setIsSeeking(false)}
      />

      {/* Buffering indicator */}
      {isBuffering && !hasError && (
        <View style={themed($bufferingOverlay)} pointerEvents="none">
          <View style={themed($bufferingSpinner)}>
            <Text style={themed($bufferingText)}>Loading...</Text>
          </View>
        </View>
      )}

      {/* Tap area to toggle controls */}
      <TouchableOpacity
        activeOpacity={1}
        style={themed($tapArea)}
        onPress={() => {
          console.log("🎮 [TapArea] Toggling controls, current state:", showControls)
          setShowControls(!showControls)
        }}
      />

      {/* Thumbnail placeholder while video loads - instant display */}
      {showThumbnail && posterUrl && !hasError && (
        <View style={themed($thumbnailOverlay)} pointerEvents="none">
          <Image source={{uri: posterUrl}} style={themed($video)} contentFit="contain" />
        </View>
      )}

      {/* Error Message Overlay */}
      {hasError && (
        <View style={themed($errorContainer)} pointerEvents="none">
          <View style={themed($errorBadge)}>
            <MaterialCommunityIcons name="alert-circle" size={60} color="#FF6B6B" />
            <Text style={themed($errorTitle)}>Playback Error</Text>
            <Text style={themed($errorMessage)}>{errorMessage}</Text>
            <Text style={themed($errorSubtext)}>This video may be corrupted or in an unsupported format.</Text>
          </View>
        </View>
      )}

      {/* Unified video controls - elegant bottom bar */}
      {showControls && !hasError && (
        <View style={themed($videoControlsContainer)} pointerEvents="auto">
          <TouchableOpacity
            style={themed($controlBarWrapper)}
            activeOpacity={1}
            onPress={() => {
              // Intercept taps on control bar area to prevent tap area from toggling controls
              console.log("🎮 [ControlBarWrapper] Tap intercepted, preventing toggle")
            }}>
            <View style={themed($unifiedControlBar)}>
              {/* Play/Pause button on left */}
              <TouchableOpacity
                onPress={() => {
                  console.log("🎮 [VideoControls] Play/Pause button pressed, current state:", isPlaying)
                  if (!isPlaying && duration > 0 && currentTime >= duration - 0.5) {
                    // Replay from beginning
                    console.log("🎮 [VideoControls] Replaying video from start")
                    videoRef.current?.seek(0)
                    setCurrentTime(0)
                    userPausedRef.current = false // User is resuming
                    setIsPlaying(true)
                  } else {
                    // Toggle play/pause
                    const newPlayingState = !isPlaying
                    console.log("🎮 [VideoControls] Toggling playback to:", newPlayingState)
                    userPausedRef.current = !newPlayingState // Set pause flag when pausing
                    setIsPlaying(newPlayingState)
                    // Keep controls visible when pausing so user can see the state
                    if (!newPlayingState) {
                      setShowControls(true)
                    }
                  }
                }}
                style={themed($playButtonInline)}
                hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
                <MaterialCommunityIcons
                  name={isPlaying ? "pause" : duration > 0 && currentTime >= duration - 0.5 ? "replay" : "play"}
                  size={28}
                  color="white"
                />
              </TouchableOpacity>

              {/* Time display */}
              <Text style={themed($timeText)}>{formatTime(currentTime)}</Text>

              {/* Seek slider */}
              <Slider
                style={themed($seekBar)}
                value={currentTime}
                minimumValue={0}
                maximumValue={duration}
                minimumTrackTintColor="#FFFFFF"
                maximumTrackTintColor="rgba(255,255,255,0.3)"
                thumbTintColor="#FFFFFF"
                onSlidingStart={() => setIsSeeking(true)}
                onSlidingComplete={(value) => {
                  videoRef.current?.seek(value)
                }}
              />

              {/* Duration display */}
              <Text style={themed($timeText)}>{formatTime(duration)}</Text>
            </View>
          </TouchableOpacity>
        </View>
      )}
    </View>
  )
})

/**
 * Image component for gallery items
 */
const ImageItem = memo(function ImageItem({photo, setImageDimensions, isActive: _isActive}: ImageItemProps) {
  const {themed} = useAppTheme()
  const hasReportedDimensions = useRef(false)

  const imageUri = photo.filePath
    ? photo.filePath.startsWith("file://")
      ? photo.filePath
      : `file://${photo.filePath}`
    : photo.url

  // Memoize styles to prevent expo-image from restarting loads on iOS
  const imageStyle = useMemo(() => themed($image), [themed])

  return (
    <View style={themed($imageContainer)}>
      <Image
        source={{uri: imageUri}}
        style={imageStyle}
        contentFit="contain"
        priority="high"
        cachePolicy="memory-disk"
        transition={100}
        allowDownscaling={false}
        onLoad={(e) => {
          // Report dimensions back to Gallery for proper scaling - only once
          if (e.source?.width && e.source?.height && !hasReportedDimensions.current) {
            hasReportedDimensions.current = true
            setImageDimensions({
              width: e.source.width,
              height: e.source.height,
            })
          }
        }}
      />
    </View>
  )
})

/**
 * Custom overlay with header, counter, and controls
 */
interface CustomOverlayProps {
  onClose: () => void
  currentIndex: number
  total: number
  onShare?: () => void
}

function CustomOverlay({onClose, currentIndex, total, onShare}: CustomOverlayProps) {
  const insets = useSafeAreaInsets()
  const {themed} = useAppTheme()

  return (
    <View style={[themed($header), {paddingTop: insets.top}]}>
      <TouchableOpacity onPress={onClose} style={themed($closeButton)}>
        <MaterialCommunityIcons name="chevron-left" size={32} color="white" />
      </TouchableOpacity>
      <Text style={themed($counterText)}>
        {currentIndex + 1} / {total}
      </Text>
      {onShare ? (
        <TouchableOpacity onPress={onShare} style={themed($actionButton)}>
          <MaterialCommunityIcons name="share-variant" size={24} color="white" />
        </TouchableOpacity>
      ) : (
        <View style={themed($actionButton)} />
      )}
    </View>
  )
}

/**
 * Main gallery component using react-native-awesome-gallery
 */
export function AwesomeGalleryViewer({visible, photos, initialIndex, onClose, onShare}: AwesomeGalleryViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex)
  const galleryRef = useRef<GalleryRef>(null)

  console.log("🎨 [AwesomeGalleryViewer] === RENDER START ===")
  console.log("🎨 [AwesomeGalleryViewer] visible:", visible)
  console.log("🎨 [AwesomeGalleryViewer] photos.length:", photos.length)
  console.log("🎨 [AwesomeGalleryViewer] initialIndex:", initialIndex)
  console.log(
    "🎨 [AwesomeGalleryViewer] photos:",
    photos.map((p) => ({name: p.name, isVideo: p.is_video})),
  )

  // Reset index when modal opens
  useEffect(() => {
    if (visible) {
      console.log("🎨 [AwesomeGalleryViewer] Modal opened, setting index to:", initialIndex)
      setCurrentIndex(initialIndex)
      // Reset gallery to initial position
      setTimeout(() => {
        galleryRef.current?.setIndex(initialIndex, false)
      }, 50)
    }
  }, [visible, initialIndex])

  // Memoized renderItem to prevent unnecessary re-renders of gallery items
  // Pass isActive to both videos and images for optimal loading
  const renderItem = useCallback(
    ({
      item,
      index,
      setImageDimensions,
    }: {
      item: PhotoInfo
      index: number
      setImageDimensions: (dims: {width: number; height: number}) => void
    }) => {
      const isVideo =
        item.is_video || item.mime_type?.startsWith("video/") || item.name.match(/\.(mp4|mov|avi|webm|mkv)$/i)

      const isActiveItem = index === currentIndex

      console.log(
        "🎨 [AwesomeGalleryViewer] Rendering item:",
        item.name,
        "isVideo:",
        isVideo,
        "isActive:",
        isActiveItem,
      )

      if (isVideo) {
        return <VideoPlayerItem photo={item} isActive={isActiveItem} />
      }

      return <ImageItem photo={item} setImageDimensions={setImageDimensions} isActive={isActiveItem} />
    },
    [currentIndex],
  )

  // Memoized keyExtractor
  const keyExtractor = useCallback((item: PhotoInfo, index: number) => `${item.name}-${index}`, [])

  if (!visible || photos.length === 0) {
    return null
  }

  return (
    <Modal visible={visible} transparent={false} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <StatusBar hidden />
      <Gallery
        ref={galleryRef}
        data={photos}
        initialIndex={initialIndex}
        onIndexChange={(newIndex) => {
          console.log("🎨 [AwesomeGalleryViewer] Index changed to:", newIndex, photos[newIndex]?.name)
          setCurrentIndex(newIndex)
        }}
        onSwipeToClose={() => {
          console.log("🎨 [AwesomeGalleryViewer] Swipe to close triggered")
          onClose()
        }}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        numToRender={3}
        emptySpaceWidth={16}
        maxScale={3}
        doubleTapScale={2}
        pinchEnabled={true}
        swipeEnabled={true}
        doubleTapEnabled={true}
        disableVerticalSwipe={true}
        disableTransitionOnScaledImage={true}
        loop={false}
        onTap={() => {
          console.log("🎨 [AwesomeGalleryViewer] Gallery tapped")
        }}
      />

      {/* Custom overlay */}
      <CustomOverlay onClose={onClose} currentIndex={currentIndex} total={photos.length} onShare={onShare} />
    </Modal>
  )
}

// Themed styles
const $header: ThemedStyle<any> = ({spacing}) => ({
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  paddingHorizontal: spacing.s4,
  paddingBottom: spacing.s3,
  backgroundColor: "rgba(0,0,0,0.5)",
  zIndex: 100,
})

const $closeButton: ThemedStyle<any> = ({spacing}) => ({
  padding: spacing.s3,
})

const $actionButton: ThemedStyle<any> = ({spacing}) => ({
  padding: spacing.s3,
  minWidth: 44,
  minHeight: 44,
})

const $counterText: ThemedStyle<any> = ({spacing}) => ({
  color: "white",
  fontSize: 16,
  fontWeight: "600",
  marginLeft: spacing.s3,
})

// Video player styles
const $videoPlayerContainer: ThemedStyle<any> = () => ({
  flex: 1,
  width: SCREEN_WIDTH,
  height: SCREEN_HEIGHT,
  backgroundColor: "black",
  justifyContent: "center",
  alignItems: "center",
  paddingTop: SCREEN_HEIGHT * 0.05, // Shift videos 5% down for better visual balance (matches images)
})

const $video: ThemedStyle<any> = () => ({
  width: "100%",
  aspectRatio: 4 / 3,
})

const $tapArea: ThemedStyle<any> = () => ({
  position: "absolute",
  top: 0,
  left: 0,
  bottom: SCREEN_HEIGHT * 0.15, // Don't cover bottom controls area - allows swipes near controls
  right: 0,
  zIndex: 1,
})

const $errorContainer: ThemedStyle<any> = () => ({
  position: "absolute",
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  backgroundColor: "rgba(0,0,0,0.85)",
  justifyContent: "center",
  alignItems: "center",
  zIndex: 50,
})

const $errorBadge: ThemedStyle<any> = ({spacing}) => ({
  backgroundColor: "rgba(30,30,30,0.95)",
  borderRadius: 16,
  padding: spacing.s8,
  alignItems: "center",
  maxWidth: SCREEN_WIDTH * 0.8,
  borderWidth: 2,
  borderColor: "rgba(255,107,107,0.3)",
})

const $errorTitle: ThemedStyle<any> = ({spacing}) => ({
  fontSize: 20,
  fontWeight: "bold",
  color: "#FF6B6B",
  marginTop: spacing.s4,
  marginBottom: spacing.s2,
})

const $errorMessage: ThemedStyle<any> = ({spacing}) => ({
  fontSize: 16,
  color: "white",
  textAlign: "center",
  marginBottom: spacing.s3,
})

const $errorSubtext: ThemedStyle<any> = () => ({
  fontSize: 13,
  color: "rgba(255,255,255,0.6)",
  textAlign: "center",
  lineHeight: 18,
})

const $videoControlsContainer: ThemedStyle<any> = ({spacing}) => ({
  position: "absolute",
  bottom: SCREEN_HEIGHT * 0.1, // 10% from bottom - scales with screen size
  left: 0,
  right: 0,
  paddingHorizontal: spacing.s6,
  zIndex: 100,
})

const $controlBarWrapper: ThemedStyle<any> = () => ({
  width: "100%",
})

const $unifiedControlBar: ThemedStyle<any> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  backgroundColor: "rgba(0,0,0,0.85)",
  borderRadius: 16,
  paddingVertical: spacing.s3,
  paddingHorizontal: spacing.s4,
  gap: spacing.s3,
})

const $playButtonInline: ThemedStyle<any> = () => ({
  width: 40,
  height: 40,
  justifyContent: "center",
  alignItems: "center",
  borderRadius: 20,
  backgroundColor: "rgba(255,255,255,0.15)",
})

const $seekBar: ThemedStyle<any> = () => ({
  flex: 1,
  height: 40,
})

const $timeText: ThemedStyle<any> = () => ({
  color: "white",
  fontSize: 13,
  fontWeight: "500",
  minWidth: 45,
  textAlign: "center",
})

// Image item styles
const $imageContainer: ThemedStyle<any> = () => ({
  width: SCREEN_WIDTH,
  height: SCREEN_HEIGHT,
  justifyContent: "center",
  alignItems: "center",
  paddingTop: SCREEN_HEIGHT * 0.05, // Shift images 5% down for better visual balance
})

const $image: ThemedStyle<any> = () => ({
  width: SCREEN_WIDTH,
  height: SCREEN_HEIGHT,
})

const $thumbnailOverlay: ThemedStyle<any> = () => ({
  position: "absolute",
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  backgroundColor: "black",
  justifyContent: "center",
  alignItems: "center",
  zIndex: 5,
})

const $bufferingOverlay: ThemedStyle<any> = () => ({
  position: "absolute",
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  backgroundColor: "rgba(0,0,0,0.3)",
  justifyContent: "center",
  alignItems: "center",
  zIndex: 10,
})

const $bufferingSpinner: ThemedStyle<any> = ({spacing}) => ({
  backgroundColor: "rgba(0,0,0,0.7)",
  borderRadius: 12,
  paddingVertical: spacing.s4,
  paddingHorizontal: spacing.s6,
})

const $bufferingText: ThemedStyle<any> = () => ({
  color: "white",
  fontSize: 14,
  fontWeight: "500",
})
