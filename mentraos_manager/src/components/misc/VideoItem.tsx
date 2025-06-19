import React from "react"
import {View, Text, StyleSheet, TouchableOpacity} from "react-native"
import Icon from "react-native-vector-icons/MaterialIcons"
import VideoThumbnail from "./VideoThumbnail"
import {useAppTheme} from "@/utils/useAppTheme"

interface VideoItemProps {
  videoPath: string
  onPlayVideo: (filePath: string) => void
  onShareVideo: (filePath: string) => void
  onDeleteVideo: (filePath: string) => void
  showSourceBadge?: boolean // Optional prop to show source badge
}

const VideoItem: React.FC<VideoItemProps> = ({
  videoPath,
  onPlayVideo,
  onShareVideo,
  onDeleteVideo,
  showSourceBadge = false,
}) => {
  const {theme} = useAppTheme()
  // Extract filename from path
  const filename = videoPath.split("/").pop() || ""
  // Convert timestamp in filename to readable date
  let dateString = "Unknown date"
  let timestamp = 0
  const match = filename.match(/glasses-recording-(\d+)\.mp4/)
  if (match && match[1]) {
    timestamp = parseInt(match[1])
    dateString = new Date(timestamp).toLocaleString()
  }

  return (
    <TouchableOpacity
      style={[styles.videoItem, {backgroundColor: theme.colors.background, borderColor: theme.colors.border}]}
      onPress={() => onPlayVideo(videoPath)}
      activeOpacity={0.7}>
      <View style={styles.videoItemContent}>
        {/* Left: Video Thumbnail */}
        <View style={styles.thumbnailContainer}>
          <VideoThumbnail videoPath={videoPath} isDarkTheme={theme.isDark} />
        </View>

        {/* Right: Info and Actions */}
        <View style={styles.videoInfoContainer}>
          {/* Date and Time */}
          <Text style={[styles.videoDate, {color: theme.colors.text}]}>
            {timestamp
              ? new Date(timestamp).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })
              : "Unknown date"}
          </Text>

          <Text style={[styles.videoTime, {color: theme.colors.text}]}>
            {timestamp
              ? new Date(timestamp).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : ""}
          </Text>

          {/* Action Buttons */}
          <View style={styles.videoActions}>
            <TouchableOpacity
              style={[styles.videoActionButton, {backgroundColor: theme.colors.buttonPrimary}]}
              onPress={e => {
                e.stopPropagation() // Prevent triggering the card's onPress
                onShareVideo(videoPath)
              }}>
              <Icon name="share" size={16} color={theme.colors.palette.neutral100} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.videoActionButton, {backgroundColor: theme.colors.buttonDanger}]}
              onPress={e => {
                e.stopPropagation() // Prevent triggering the card's onPress
                onDeleteVideo(videoPath)
              }}>
              <Icon name="delete" size={16} color={theme.colors.palette.neutral100} />
            </TouchableOpacity>
          </View>

          {/* Source badge */}
          {showSourceBadge && (
            <View style={[styles.sourceBadge, {backgroundColor: theme.colors.overlay60}]}>
              <Text style={[styles.sourceBadgeText, {color: theme.colors.palette.neutral100}]}>Local</Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  sourceBadge: {
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
    position: "absolute",
    right: 8,
    top: 8,
  },
  sourceBadgeText: {
    fontFamily: "Montserrat-Medium",
    fontSize: 10,
  },
  thumbnailContainer: {
    padding: 8,
  },
  videoActionButton: {
    width: 36, // Smaller buttons
    height: 36, // Smaller buttons
    borderRadius: 18, // Circular buttons
    justifyContent: "center",
    alignItems: "center",
    elevation: 2,
    shadowColor: "#000",
    shadowOffset: {width: 0, height: 1},
    shadowOpacity: 0.2,
    shadowRadius: 2,
  },
  videoActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10, // Gap between buttons
  },
  videoDate: {
    fontFamily: "Montserrat-Bold",
    fontSize: 14,
    fontWeight: "bold",
    marginBottom: 4,
  },
  videoInfoContainer: {
    flex: 1,
    justifyContent: "center",
    padding: 12,
  },
  videoItem: {
    borderRadius: 12,
    borderWidth: 0.5,
    elevation: 3,
    marginBottom: 12,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  videoItemContent: {
    alignItems: "center",
    flexDirection: "row",
  },
  videoTime: {
    fontFamily: "Montserrat-Regular",
    fontSize: 13,
    marginBottom: 10,
    opacity: 0.7,
  },
})

export default VideoItem
