import React, {useState, useEffect, useCallback} from "react"
import {
  TouchableOpacity,
  Platform,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  Modal,
  Image,
  ToastAndroid,
  ViewStyle,
  TextStyle,
  ImageStyle,
  View,
} from "react-native"
import {useNavigation} from "@react-navigation/native"
import {Header, Screen, Text} from "@/components/ignite"
import GlassesDisplayMirror from "@/components/misc/GlassesDisplayMirror"
import {useStatus} from "@/contexts/AugmentOSStatusProvider"
import {useGlassesMirror} from "@/contexts/GlassesMirrorContext"
import Icon from "react-native-vector-icons/MaterialIcons"
import VideoItem from "@/components/misc/VideoItem"
import PhotoItem from "@/components/misc/PhotoItem"
import {showAlert} from "@/utils/AlertUtils"
import {shareFile} from "@/utils/FileUtils"
import RNFS from "react-native-fs"
import BackendServerComms from "@/backend_comms/BackendServerComms"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {ThemedStyle} from "@/theme"
import {useSafeAreaInsetsStyle} from "@/utils/useSafeAreaInsetsStyle"
import {useAppTheme} from "@/utils/useAppTheme"
import {router} from "expo-router"
interface GalleryPhoto {
  id: string
  photoUrl: string
  uploadDate: string
  appId: string
  userId: string
}

// Unified MediaItem interface for both local recordings and cloud photos
interface MediaItem {
  id: string // Unique identifier
  sourceType: "local" | "cloud" // Origin of the item
  mediaType: "video" | "photo" // Type of media
  thumbnailUrl: string // URL or path to thumbnail
  contentUrl: string // URL or path to full content
  timestamp: number // Milliseconds since epoch
  formattedDate?: string // Pre-formatted date for display
  formattedTime?: string // Pre-formatted time for display
  metadata: {
    appId?: string // Source app for cloud photos
    fileName?: string // For local recordings
    // Other metadata as needed
  }
}

export default function GlassesMirror() {
  const {status} = useStatus()
  const {events} = useGlassesMirror() // From context
  const $bottomContainerInsets = useSafeAreaInsetsStyle(["bottom"])
  const {theme, themed} = useAppTheme()

  // Helper to check if we have a glasses model name
  const isGlassesConnected = !!status.glasses_info?.model_name

  // Get only the last event
  const lastEvent = events.length > 0 ? events[events.length - 1] : null

  // Function to navigate to fullscreen mode
  const navigateToFullScreen = () => {
    router.push("/mirror/fullscreen")
  }

  // Gallery state
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]) // Unified media items array
  const [isLoading, setIsLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedPhoto, setSelectedPhoto] = useState<GalleryPhoto | null>(null)
  const [photoModalVisible, setPhotoModalVisible] = useState(false)

  const backend = BackendServerComms.getInstance()

  // Load gallery contents on component mount
  useEffect(() => {
    loadAllMedia()
  }, [])

  // Pull to refresh handler
  const onRefresh = useCallback(() => {
    setRefreshing(true)
    loadAllMedia()
      .catch(err => console.error("Error during refresh:", err))
      .finally(() => setRefreshing(false))
  }, [])

  // Adapter function to convert local recording to MediaItem
  const mapLocalRecordingToMediaItem = (filePath: string): MediaItem => {
    const filename = filePath.split("/").pop() || ""
    const match = filename.match(/glasses-recording-(\d+)\.mp4/)
    const timestamp = match && match[1] ? parseInt(match[1]) : Date.now()

    // Format date strings for display
    const date = new Date(timestamp)
    const formattedDate = date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
    const formattedTime = date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    })

    return {
      id: filePath,
      sourceType: "local",
      mediaType: "video",
      thumbnailUrl: filePath, // Video thumbnail is generated from this path
      contentUrl: filePath,
      timestamp,
      formattedDate,
      formattedTime,
      metadata: {
        fileName: filename,
      },
    }
  }

  // Adapter function to convert cloud photo to MediaItem
  const mapCloudPhotoToMediaItem = (photo: GalleryPhoto): MediaItem => {
    const timestamp = new Date(photo.uploadDate).getTime()

    // Format date strings for display
    const date = new Date(timestamp)
    const formattedDate = date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
    const formattedTime = date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    })

    return {
      id: photo.id,
      sourceType: "cloud",
      mediaType: "photo",
      thumbnailUrl: photo.photoUrl,
      contentUrl: photo.photoUrl,
      timestamp,
      formattedDate,
      formattedTime,
      metadata: {
        appId: photo.appId,
      },
    }
  }

  // Load recorded videos from device
  const loadRecordings = async () => {
    try {
      // Define the videos directory
      const videoDir =
        Platform.OS === "ios"
          ? `${RNFS.DocumentDirectoryPath}/AugmentOSRecordings`
          : `${RNFS.ExternalDirectoryPath}/AugmentOSRecordings`

      // Check if directory exists, create if not
      const dirExists = await RNFS.exists(videoDir)
      if (!dirExists) {
        await RNFS.mkdir(videoDir)
        return []
      }

      // Read directory contents
      const files = await RNFS.readDir(videoDir)

      // Filter for video files
      const videoFiles = files
        .filter(file => file.name.endsWith(".mp4"))
        .map(file => file.path)
        .sort((a, b) => {
          // Sort by creation time (latest first)
          return b.localeCompare(a)
        })

      // Convert to MediaItem format
      const mediaItems = videoFiles.map(filePath => mapLocalRecordingToMediaItem(filePath))
      return mediaItems
    } catch (error) {
      console.error("Error loading recordings:", error)
      return []
    }
  }

  // Load gallery photos from cloud
  const loadGalleryPhotos = async () => {
    try {
      const response = await backend.getGalleryPhotos()
      if (response && response.success && response.photos) {
        // Convert to MediaItem format
        const mediaItems = response.photos.map((photo: GalleryPhoto) => mapCloudPhotoToMediaItem(photo))
        return mediaItems
      }
      return []
    } catch (error) {
      console.error("Error loading gallery photos:", error)
      return []
    }
  }

  // Load all media (both local and cloud)
  const loadAllMedia = async () => {
    setIsLoading(true)

    // Use state variable to track if we should show cloud connectivity warning
    let shouldShowCloudWarning = false

    // Start both loading processes in parallel and handle potential failures
    const results = await Promise.allSettled([loadRecordings(), loadGalleryPhotos()])

    // Process results, extracting data from fulfilled promises
    const localItems = results[0].status === "fulfilled" ? results[0].value : []

    // Check if cloud items failed to load
    let cloudItems: MediaItem[] = []
    if (results[1].status === "fulfilled") {
      cloudItems = results[1].value
    } else {
      console.error("Failed to load cloud items:", results[1].reason)
      shouldShowCloudWarning = true
    }

    // Combine whatever items we successfully loaded
    const combinedItems = [...localItems, ...cloudItems]

    // Sort by timestamp (newest first)
    combinedItems.sort((a, b) => b.timestamp - a.timestamp)

    // Update state with available items
    setMediaItems(combinedItems)

    // Show non-blocking toast/message if cloud items failed to load
    if (shouldShowCloudWarning && Platform.OS === "android") {
      ToastAndroid.show("Some cloud items could not be loaded", ToastAndroid.SHORT)
    } else if (shouldShowCloudWarning) {
      // Use a non-blocking approach for iOS instead of an alert
      GlobalEventEmitter.emit("SHOW_BANNER", {
        message: "Some cloud items could not be loaded",
        type: "warning",
      })
    }

    setIsLoading(false)

    return Promise.resolve()
  }

  // Share a video file
  const shareVideo = async (filePath: string) => {
    try {
      console.log("GlassesMirror: Starting video share for:", filePath)

      // Use our utility function that handles both platforms properly
      await shareFile(
        filePath,
        "video/mp4",
        "Share AugmentOS Recording",
        "Check out this recording from my smart glasses!",
      )

      console.log("GlassesMirror: Share completed successfully")
    } catch (error) {
      console.error("GlassesMirror: Error sharing video:", error)

      // Check if it's a file provider error (likely on first run after adding the module)
      if (
        error instanceof Error &&
        (error.message?.includes("FileProvider") || error.message?.includes("content://"))
      ) {
        // Special error for FileProvider issues
        showAlert(
          "Sharing Not Available",
          "File sharing requires app restart after update. Please close and reopen the app, then try again.",
          undefined,
          {iconName: "refresh", iconColor: "#FF9500"},
        )
      } else {
        // Generic error
        showAlert("Sharing Error", "Failed to share the video. Please try again.", undefined, {
          iconName: "error",
          iconColor: "#FF3B30",
        })
      }
    }
  }

  // Play video in our custom video player
  const playVideo = (filePath: string) => {
    try {
      // Extract filename from path for display
      const fileName = filePath.split("/").pop() || ""

      // Navigate to our custom video player screen
      router.push("/mirror/video-player", {
        // filePath: filePath,
        // fileName: fileName,
      })
    } catch (error) {
      console.error("Error playing video:", error)
      showAlert("Playback Error", "Unable to play the video. Please try again.", undefined, {
        iconName: "error",
        iconColor: "#FF3B30",
      })
    }
  }

  // Delete a recorded video
  const deleteVideo = async (filePath: string) => {
    try {
      // Confirm before deleting
      showAlert(
        "Delete Recording",
        "Are you sure you want to delete this recording?",
        [
          {
            text: "Cancel",
            style: "cancel",
          },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              try {
                await RNFS.unlink(filePath)
                // Reload all media to update the list
                await loadAllMedia()
                if (Platform.OS === "android") {
                  ToastAndroid.show("Recording deleted", ToastAndroid.SHORT)
                } else {
                  showAlert("Success", "Recording deleted successfully", undefined, {
                    iconName: "check-circle",
                    iconColor: "#4CAF50",
                  })
                }
              } catch (error) {
                console.error("Error deleting video:", error)
                showAlert("Error", "Failed to delete the recording", undefined, {
                  iconName: "error",
                  iconColor: "#FF3B30",
                })
              }
            },
          },
        ],
        {
          iconName: "delete",
          iconColor: "#FF3B30",
        },
      )
    } catch (error) {
      console.error("Error deleting video:", error)
      showAlert("Delete Error", "Failed to delete the video", undefined, {
        iconName: "error",
        iconColor: "#FF3B30",
      })
    }
  }

  // View a photo in full screen modal
  const viewPhoto = (photo: GalleryPhoto) => {
    setSelectedPhoto(photo)
    setPhotoModalVisible(true)
  }

  // Delete a photo from the gallery
  const deletePhoto = async (photoId: string) => {
    try {
      // Confirm before deleting
      showAlert(
        "Delete Photo",
        "Are you sure you want to delete this photo?",
        [
          {
            text: "Cancel",
            style: "cancel",
          },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              try {
                await backend.deleteGalleryPhoto(photoId)
                // Reload all media to update the list
                await loadAllMedia()
                if (Platform.OS === "android") {
                  ToastAndroid.show("Photo deleted", ToastAndroid.SHORT)
                } else {
                  showAlert("Success", "Photo deleted successfully", undefined, {
                    iconName: "check-circle",
                    iconColor: "#4CAF50",
                  })
                }
              } catch (error) {
                console.error("Error deleting photo:", error)
                showAlert("Error", "Failed to delete the photo", undefined, {
                  iconName: "error",
                  iconColor: "#FF3B30",
                })
              }
            },
          },
        ],
        {
          iconName: "delete",
          iconColor: "#FF3B30",
        },
      )
    } catch (error) {
      console.error("Error deleting photo:", error)
      showAlert("Delete Error", "Failed to delete the photo", undefined, {
        iconName: "error",
        iconColor: "#FF3B30",
      })
    }
  }

  // Render empty state content for gallery
  const renderEmptyGalleryState = () => {
    return (
      <View style={themed($emptyContainer)}>
        <Text style={themed($emptyText)} preset="bold">
          No media found
        </Text>
        <Text style={themed($emptySubtext)} preset="default">
          {isGlassesConnected
            ? "Recordings from Glasses Mirror and camera-enabled smart glasses will appear here"
            : "Connect smart glasses to record or use apps that save to gallery"}
        </Text>
      </View>
    )
  }

  return (
    <Screen preset="fixed" style={{paddingHorizontal: theme.spacing.lg}}>
      <Header
        leftTx="mirror:title"
        RightActionComponent={
          <TouchableOpacity onPress={navigateToFullScreen} style={{marginRight: 16}}>
            <Icon
              name="camera"
              size={24}
              color={isGlassesConnected && lastEvent ? theme.colors.text : theme.colors.textDim}
            />
          </TouchableOpacity>
        }
      />

      <ScrollView
        style={{marginRight: -theme.spacing.md, paddingRight: theme.spacing.md}}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[theme.colors.palette.primary500]}
            tintColor={theme.colors.text}
          />
        }>
        {/* Mirror Content */}
        <View style={themed($mirrorSection)}>
          {isGlassesConnected ? (
            <View style={themed($contentContainer)}>
              {lastEvent ? (
                <GlassesDisplayMirror layout={lastEvent.layout} fallbackMessage="Unknown layout data" />
              ) : (
                <View style={themed($fallbackContainer)}>
                  <Text style={themed($fallbackText)}>No display events available</Text>
                </View>
              )}
            </View>
          ) : (
            <View style={themed($fallbackContainer)}>
              <Text style={themed($fallbackText)}>Connect smart glasses to use the Glasses Mirror</Text>
            </View>
          )}
        </View>

        {/* Gallery Section */}
        <View style={themed($gallerySection)}>
          <Header leftText="Gallery" />

          {/* Gallery Content */}
          <View style={themed($galleryContent)}>
            {isLoading ? (
              <View style={themed($loadingContainer)}>
                <ActivityIndicator size="large" color={theme.colors.palette.primary500} />
                <Text style={themed($loadingText)}>Loading media...</Text>
              </View>
            ) : // Content based on data availability
            mediaItems.length === 0 ? (
              renderEmptyGalleryState()
            ) : (
              <View style={themed($contentList)}>
                {/* Unified media content */}
                {mediaItems.map((item, index) =>
                  item.mediaType === "video" ? (
                    <VideoItem
                      key={`video-${index}`}
                      videoPath={item.contentUrl}
                      isDarkTheme={theme.isDark}
                      onPlayVideo={playVideo}
                      onShareVideo={shareVideo}
                      onDeleteVideo={deleteVideo}
                      showSourceBadge={true}
                    />
                  ) : (
                    <PhotoItem
                      key={`photo-${index}`}
                      photo={{
                        id: item.id,
                        photoUrl: item.contentUrl,
                        uploadDate: new Date(item.timestamp).toISOString(),
                        appId: item.metadata.appId || "Unknown",
                      }}
                      isDarkTheme={theme.isDark}
                      onViewPhoto={viewPhoto}
                      onDeletePhoto={deletePhoto}
                      showSourceBadge={true}
                    />
                  ),
                )}
              </View>
            )}
          </View>
        </View>

        {/* Photo viewer modal */}
        <Modal
          visible={photoModalVisible}
          transparent={true}
          animationType="fade"
          onRequestClose={() => setPhotoModalVisible(false)}>
          <View style={getModalStyles(theme).modalContainer}>
            <TouchableOpacity style={getModalStyles(theme).closeButton} onPress={() => setPhotoModalVisible(false)}>
              <Icon name="close" size={24} color="white" />
            </TouchableOpacity>

            {selectedPhoto && (
              <View style={$modalImageContainer}>
                <Image source={{uri: selectedPhoto.photoUrl}} style={$fullscreenImage} resizeMode="contain" />
                <View style={getPhotoDetailsStyle(theme)}>
                  <Text style={$photoDetailText} preset="default">
                    {new Date(selectedPhoto.uploadDate).toLocaleString()}
                  </Text>
                  <Text style={$photoDetailText} preset="default">
                    From app: {selectedPhoto.appId}
                  </Text>
                </View>
              </View>
            )}
          </View>
        </Modal>
      </ScrollView>
    </Screen>
  )
}

// Themed styles
const $container: ThemedStyle<ViewStyle> = ({colors}) => ({
  flex: 1,
  backgroundColor: colors.background,
})

const $titleContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingVertical: spacing.md,
  paddingHorizontal: spacing.lg,
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: spacing.sm,
})

const $title: ThemedStyle<TextStyle> = () => ({
  textAlign: "left",
  flex: 1,
  marginBottom: 5,
})

const $mirrorSection: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginBottom: spacing.lg,
})

const $contentContainer: ThemedStyle<ViewStyle> = () => ({
  justifyContent: "center",
  alignItems: "center",
})

const $fallbackContainer: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  minHeight: 200,
})

const $fallbackText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 16,
  color: colors.text,
  textAlign: "center",
  marginHorizontal: spacing.lg,
})

const $gallerySection: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingBottom: spacing.lg,
})

const $sectionTitle: ThemedStyle<TextStyle> = ({spacing, colors}) => ({
  marginBottom: spacing.md,
  fontSize: 16,
  fontWeight: "500",
  color: colors.text,
  fontFamily: undefined, // Ensure it uses the default system font
  marginLeft: 0, // Align with header text
})

const $galleryContent: ThemedStyle<ViewStyle> = () => ({
  minHeight: 200,
})

const $loadingContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  justifyContent: "center",
  alignItems: "center",
  padding: spacing.lg,
  minHeight: 200,
})

const $loadingText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  marginTop: spacing.sm,
  fontSize: 16,
  color: colors.text,
})

const $emptyContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  justifyContent: "center",
  alignItems: "center",
  paddingVertical: spacing.xl,
  minHeight: 200,
})

const $emptyText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 18,
  color: colors.text,
  marginBottom: 10,
  textAlign: "center",
})

const $emptySubtext: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  color: colors.textDim,
  marginBottom: spacing.lg,
  textAlign: "center",
})

const $contentList: ThemedStyle<ViewStyle> = () => ({
  padding: 0,
})

// Modal styles that need theme access
const getModalStyles = (theme: any) => ({
  modalContainer: {
    flex: 1,
    backgroundColor: theme.colors.palette.overlay90 || "rgba(0, 0, 0, 0.9)",
    justifyContent: "center",
    alignItems: "center",
  } as ViewStyle,
  
  closeButton: {
    position: "absolute",
    top: 40,
    right: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.colors.palette.overlay50 || "rgba(0, 0, 0, 0.5)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 10,
  } as ViewStyle,
})

const $modalImageContainer: ViewStyle = {
  width: "100%",
  height: "100%",
  justifyContent: "center",
  alignItems: "center",
}

const $fullscreenImage: ImageStyle = {
  width: "90%",
  height: "70%",
  borderRadius: 8,
}

const getPhotoDetailsStyle = (theme: any): ViewStyle => ({
  position: "absolute",
  bottom: 40,
  left: 0,
  right: 0,
  padding: 16,
  backgroundColor: theme.colors.palette.overlay50,
  alignItems: "center",
})

const $photoDetailText: TextStyle = {
  color: "white",
  fontSize: 14,
  marginBottom: 4,
}
