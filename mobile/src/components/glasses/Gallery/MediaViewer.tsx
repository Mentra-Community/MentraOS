/**
 * Media viewer component that handles both images and videos
 */

import Slider from "@react-native-community/slider"
import {useState, useRef, useEffect, type ElementRef} from "react"
import {View, TouchableOpacity, Modal, StatusBar} from "react-native"
// eslint-disable-next-line no-restricted-imports
import {Text, StyleSheet} from "react-native"
import {useSafeAreaInsets} from "react-native-safe-area-context"
import MaterialCommunityIcons from "react-native-vector-icons/MaterialCommunityIcons"
import Video from "react-native-video"

import {spacing} from "@/theme"
import {PhotoInfo} from "@/types/asg"

import {ImageViewer} from "./ImageViewer"

interface MediaViewerProps {
  visible: boolean
  photo: PhotoInfo | null
  onClose: () => void
  onShare?: () => void
  onDelete?: () => void
}

export function MediaViewer({visible, photo, onClose, onShare, onDelete: _onDelete}: MediaViewerProps) {
  const insets = useSafeAreaInsets()
  const videoRef = useRef<ElementRef<typeof Video>>(null)
  const [isPlaying, setIsPlaying] = useState(true) // Autoplay video
  const [showControls, setShowControls] = useState(true) // Start with controls visible
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isSeeking, setIsSeeking] = useState(false)

  // Determine if this is a video (before any returns to avoid hooks order issues)
  const isVideo = photo
    ? photo.is_video || photo.mime_type?.startsWith("video/") || photo.name.match(/\.(mp4|mov|avi|webm|mkv)$/i)
    : false

  // Reset state when modal opens/closes or photo changes
  useEffect(() => {
    if (visible && isVideo) {
      setIsPlaying(true) // Autoplay when opening
      setShowControls(true)
      setCurrentTime(0)
      setDuration(0)
      setIsSeeking(false)
    }
  }, [visible, photo, isVideo])

  // Hide controls after 3 seconds of inactivity (must be before any conditional returns)
  useEffect(() => {
    if (isVideo && showControls && isPlaying) {
      const timer = setTimeout(() => setShowControls(false), 3000)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [isVideo, showControls, isPlaying])

  if (!photo) return null

  // For images, use our custom image viewer
  if (!isVideo) {
    return <ImageViewer visible={visible} photo={photo} onClose={onClose} onShare={onShare} />
  }

  // For videos, use a custom modal with video player
  // Use download URL for videos (actual video file) instead of photo URL (thumbnail)
  const videoUrl = photo.download || photo.url
  console.log("[MediaViewer] Playing video from URL:", videoUrl)

  // Format time in MM:SS
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, "0")}`
  }

  return (
    <Modal visible={visible} transparent={false} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.videoContainer}>
        <StatusBar hidden />

        {/* Video Player */}
        <View style={styles.videoWrapper}>
          <Video
            ref={videoRef}
            source={{uri: videoUrl}}
            style={styles.video}
            resizeMode="contain"
            paused={!isPlaying}
            controls={false} // Disable native controls
            onProgress={({currentTime}) => {
              if (!isSeeking) {
                setCurrentTime(currentTime)
              }
            }}
            onLoad={({duration}) => setDuration(duration)}
            onError={error => {
              console.error("Video error:", error)
              console.error("Failed to play video from URL:", videoUrl)
            }}
            onEnd={() => setIsPlaying(false)}
            onSeek={() => setIsSeeking(false)}
          />

          {/* Invisible tap area to toggle controls */}
          <TouchableOpacity
            activeOpacity={1}
            style={styles.tapArea}
            onPress={() => {
              console.log("[MediaViewer] Toggling controls, current state:", showControls)
              setShowControls(!showControls)
            }}
          />
        </View>

        {/* Header - Show/hide with controls */}
        {showControls && (
          <View style={[styles.header, {paddingTop: insets.top}]}>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <MaterialCommunityIcons name="chevron-left" size={32} color="white" />
            </TouchableOpacity>
            <View style={{flex: 1}} />
            {onShare && (
              <TouchableOpacity onPress={onShare} style={styles.actionButton}>
                <MaterialCommunityIcons name="share-variant" size={24} color="white" />
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Play/Pause Button in Center */}
        {showControls && (
          <TouchableOpacity
            onPress={e => {
              e.stopPropagation()
              console.log(
                "[MediaViewer] Play/Pause button pressed, isPlaying:",
                isPlaying,
                "currentTime:",
                currentTime,
                "duration:",
                duration,
              )

              // If video is at the end (within 0.5 seconds of end), restart from beginning
              if (!isPlaying && duration > 0 && currentTime >= duration - 0.5) {
                console.log("[MediaViewer] Restarting video from beginning")
                videoRef.current?.seek(0)
                setCurrentTime(0)
                setIsPlaying(true)
              } else {
                setIsPlaying(!isPlaying)
              }
            }}
            style={styles.centerPlayButton}
            hitSlop={{top: 20, bottom: 20, left: 20, right: 20}}>
            <View style={[styles.playButtonBackground, isPlaying && styles.playButtonPlaying]}>
              <MaterialCommunityIcons
                name={isPlaying ? "pause" : duration > 0 && currentTime >= duration - 0.5 ? "replay" : "play"}
                size={50}
                color="white"
                style={isPlaying || (duration > 0 && currentTime >= duration - 0.5) ? {} : {marginLeft: 4}} // Adjust play icon to be centered
              />
            </View>
          </TouchableOpacity>
        )}

        {/* Bottom Controls - Seek Bar */}
        {showControls && (
          <View style={styles.bottomControls} pointerEvents="box-none">
            <View style={styles.seekContainer}>
              <Text style={styles.timeText}>{formatTime(currentTime)}</Text>
              <Slider
                style={styles.seekBar}
                value={currentTime}
                minimumValue={0}
                maximumValue={duration}
                minimumTrackTintColor="#FFFFFF"
                maximumTrackTintColor="rgba(255,255,255,0.3)"
                thumbTintColor="#FFFFFF"
                onSlidingStart={() => setIsSeeking(true)}
                onSlidingComplete={value => {
                  videoRef.current?.seek(value)
                }}
              />
              <Text style={styles.timeText}>{formatTime(duration)}</Text>
            </View>
          </View>
        )}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  header: {
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
    zIndex: 100, // Higher z-index than tap area
  },
  closeButton: {
    padding: spacing.s3,
  },
  actionButton: {
    padding: spacing.s3,
  },
  videoContainer: {
    flex: 1,
    backgroundColor: "black",
  },
  videoWrapper: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  video: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
  },
  tapArea: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    zIndex: 1, // Lower z-index than controls
  },
  centerPlayButton: {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: [{translateX: -40}, {translateY: -40}],
    zIndex: 100,
  },
  playButtonBackground: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
  },
  playButtonPlaying: {
    backgroundColor: "rgba(0,0,0,0.3)", // More transparent when playing
  },
  bottomControls: {
    position: "absolute",
    bottom: spacing.s8, // Same margin as sync button
    left: 0,
    right: 0,
    paddingHorizontal: spacing.s6,
    zIndex: 100,
  },
  seekContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.7)",
    borderRadius: 16,
    paddingVertical: spacing.s3,
    paddingHorizontal: spacing.s4,
  },
  seekBar: {
    flex: 1,
    height: 40,
    marginHorizontal: spacing.s3,
  },
  timeText: {
    color: "white",
    fontSize: 12,
    minWidth: 45,
    textAlign: "center",
  },
})
