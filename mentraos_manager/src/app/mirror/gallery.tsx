import React, {useState, useEffect, useCallback} from "react"
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Platform,
  ToastAndroid,
  ActivityIndicator,
  SafeAreaView,
  Image,
  Modal,
  RefreshControl,
  StatusBar,
} from "react-native"
import {showAlert} from "@/utils/AlertUtils"
import {useNavigation} from "@react-navigation/native"
import RNFS from "react-native-fs"
import Icon from "react-native-vector-icons/MaterialIcons"
import {shareFile} from "@/utils/FileUtils"
import VideoItem from "@/components/misc/VideoItem"
import PhotoItem from "@/components/misc/PhotoItem"
import BackendServerComms from "@/backend_comms/BackendServerComms"
import {router} from "expo-router"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {useAppTheme} from "@/utils/useAppTheme"

interface GlassesRecordingsGalleryProps {
  isDarkTheme: boolean
}

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

type GalleryTab = "device" | "cloud"

const GlassesRecordingsGallery: React.FC<GlassesRecordingsGalleryProps> = ({isDarkTheme}) => {
  const {theme} = useAppTheme()
  // State variables
  const [activeTab, setActiveTab] = useState<GalleryTab>("device")
  const [recordedVideos, setRecordedVideos] = useState<string[]>([])
  const [galleryPhotos, setGalleryPhotos] = useState<GalleryPhoto[]>([])
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]) // Unified media items array
  const [isLoading, setIsLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedPhoto, setSelectedPhoto] = useState<GalleryPhoto | null>(null)
  const [photoModalVisible, setPhotoModalVisible] = useState(false)
  const backend = BackendServerComms.getInstance()

  useEffect(() => {
    // Load all media on component mount
    loadAllMedia()

    // Ensure status bar is visible
    StatusBar.setHidden(false)
    // Set appropriate styling for the status bar based on theme
    StatusBar.setBarStyle(theme.isDark ? "light-content" : "dark-content")

    return () => {
      // No cleanup needed for status bar, let the next screen handle it
    }
  }, [isDarkTheme])

  // Pull to refresh handler
  const onRefresh = useCallback(() => {
    setRefreshing(true)
    // The loadAllMedia function now handles failures properly
    // so we can safely chain the promise regardless of success/failure
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
      setIsLoading(true)
      // Define the videos directory
      const videoDir =
        Platform.OS === "ios"
          ? `${RNFS.DocumentDirectoryPath}/MentraOSRecordings`
          : `${RNFS.ExternalDirectoryPath}/MentraOSRecordings`

      // Check if directory exists, create if not
      const dirExists = await RNFS.exists(videoDir)
      if (!dirExists) {
        await RNFS.mkdir(videoDir)
        setRecordedVideos([])
        setIsLoading(false)
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

      setRecordedVideos(videoFiles)

      // Convert to MediaItem format
      const mediaItems = videoFiles.map(filePath => mapLocalRecordingToMediaItem(filePath))
      return mediaItems
    } catch (error) {
      console.error("Error loading recordings:", error)
      Alert.alert("Error", "Failed to load recordings")
      return []
    } finally {
      setIsLoading(false)
    }
  }

  // Load gallery photos from cloud
  const loadGalleryPhotos = async () => {
    try {
      setIsLoading(true)

      const response = await backend.getGalleryPhotos()
      if (response && response.success && response.photos) {
        setGalleryPhotos(response.photos)

        // Convert to MediaItem format
        const mediaItems = response.photos.map((photo: GalleryPhoto) => mapCloudPhotoToMediaItem(photo))
        return mediaItems
      } else {
        console.error("Error in gallery response:", response)
        Alert.alert("Error", "Failed to load gallery photos")
        return []
      }
    } catch (error) {
      console.error("Error loading gallery photos:", error)
      Alert.alert("Error", "Failed to connect to gallery service")
      return []
    } finally {
      setIsLoading(false)
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
  }

  // Share a video file
  const shareVideo = async (filePath: string) => {
    try {
      console.log("GlassesRecordingsGallery: Starting video share for:", filePath)

      // Use our utility function that handles both platforms properly
      await shareFile(
        filePath,
        "video/mp4",
        "Share MentraOS Recording",
        "Check out this recording from my smart glasses!",
      )

      console.log("GlassesRecordingsGallery: Share completed successfully")
    } catch (error) {
      console.error("GlassesRecordingsGallery: Error sharing video:", error)

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
      router.push({pathname: "/mirror/video-player", params: {filePath: filePath, fileName: fileName}})
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
                await loadRecordings()
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
                await loadGalleryPhotos()
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

  // Render empty state content
  const renderEmptyState = () => {
    return (
      <View style={styles.emptyContainer}>
        <Text style={[styles.emptyText, {color: theme.colors.text}]}>No media found</Text>
        <Text style={[styles.emptySubtext, {color: theme.colors.textDim}]}>
          Create a recording from the glasses mirror screen or use apps that save to gallery
        </Text>
        <TouchableOpacity
          style={[styles.recordButton, {backgroundColor: theme.colors.galleryLoadingIndicator}]}
          onPress={() => router.push("/mirror/fullscreen")}>
          <Text style={[styles.recordButtonText, {color: theme.colors.icon}]}>Go to Camera</Text>
        </TouchableOpacity>
      </View>
    )
  }

  // Main component render
  return (
    <SafeAreaView style={[styles.container, {backgroundColor: theme.colors.galleryBackground}]}>
      {/* Explicitly show status bar with appropriate styling */}
      <StatusBar
        hidden={false}
        barStyle={theme.isDark ? "light-content" : "dark-content"}
        backgroundColor={theme.colors.galleryBackground}
        translucent={false}
      />

      {/* Title header */}
      <View style={[styles.titleContainer, {borderBottomColor: theme.colors.border}]}>
        <Text style={[styles.titleText, {color: theme.colors.text}]}>Media Gallery</Text>
      </View>

      {/* Loading indicator */}
      {isLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.colors.galleryLoadingIndicator} />
          <Text style={[styles.loadingText, {color: theme.colors.text}]}>Loading media...</Text>
        </View>
      ) : // Content based on data availability
      mediaItems.length === 0 ? (
        renderEmptyState()
      ) : (
        <ScrollView
          style={styles.contentList}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[theme.colors.galleryLoadingIndicator]}
              tintColor={theme.colors.text}
            />
          }>
          {/* Unified media content */}
          {mediaItems.map((item, index) =>
            item.mediaType === "video" ? (
              <VideoItem
                key={`video-${index}`}
                videoPath={item.contentUrl}
                isDarkTheme={isDarkTheme}
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
                isDarkTheme={isDarkTheme}
                onViewPhoto={viewPhoto}
                onDeletePhoto={deletePhoto}
                showSourceBadge={true}
              />
            ),
          )}
        </ScrollView>
      )}

      {/* Photo viewer modal */}
      <Modal
        visible={photoModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setPhotoModalVisible(false)}>
        <View style={[styles.modalContainer, {backgroundColor: theme.colors.modalOverlay}]}>
          <TouchableOpacity
            style={[styles.closeButton, {backgroundColor: theme.colors.fullscreenOverlay}]}
            onPress={() => setPhotoModalVisible(false)}>
            <Icon name="close" size={24} color={theme.colors.icon} />
          </TouchableOpacity>

          {selectedPhoto && (
            <View style={styles.modalImageContainer}>
              <Image source={{uri: selectedPhoto.photoUrl}} style={styles.fullscreenImage} resizeMode="contain" />
              <View style={[styles.photoDetails, {backgroundColor: theme.colors.fullscreenOverlay}]}>
                <Text style={[styles.photoDetailText, {color: theme.colors.icon}]}>
                  {new Date(selectedPhoto.uploadDate).toLocaleString()}
                </Text>
                <Text style={[styles.photoDetailText, {color: theme.colors.icon}]}>
                  From app: {selectedPhoto.appId}
                </Text>
              </View>
            </View>
          )}
        </View>
      </Modal>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 0, // No extra padding at top since we're using the React Navigation header
    // backgroundColor moved to dynamic styling
  },
  // Removed darkBackground, lightBackground, darkText, lightText - using dynamic styling
  // Title styles
  titleContainer: {
    borderBottomWidth: 1,
    paddingHorizontal: 20,
    paddingVertical: 15,
    // borderBottomColor moved to dynamic styling
  },
  titleText: {
    fontFamily: "Montserrat-Bold",
    fontSize: 20,
    textAlign: "center",
    // color moved to dynamic styling
  },
  // Loading state
  loadingContainer: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  loadingText: {
    fontFamily: "Montserrat-Regular",
    fontSize: 16,
    marginTop: 10,
    // color moved to dynamic styling
  },
  // Empty state
  emptyContainer: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  emptyText: {
    fontFamily: "Montserrat-Bold",
    fontSize: 20,
    marginBottom: 10,
    textAlign: "center",
    // color moved to dynamic styling
  },
  emptySubtext: {
    fontFamily: "Montserrat-Regular",
    fontSize: 16,
    marginBottom: 20,
    opacity: 0.7,
    textAlign: "center",
    // color moved to dynamic styling
  },
  recordButton: {
    // backgroundColor moved to dynamic styling
    paddingVertical: 12,
    paddingHorizontal: 30,
    borderRadius: 8,
    marginTop: 20,
  },
  recordButtonText: {
    // color moved to dynamic styling
    fontSize: 16,
    fontFamily: "Montserrat-Bold",
  },
  // Content list
  contentList: {
    flex: 1,
    paddingHorizontal: 20, // Match homepage padding
    paddingVertical: 10, // Reduced top padding since we have the native header now
  },
  // Modal styles
  modalContainer: {
    flex: 1,
    // backgroundColor moved to dynamic styling
    justifyContent: "center",
    alignItems: "center",
  },
  closeButton: {
    position: "absolute",
    top: 40,
    right: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    // backgroundColor moved to dynamic styling
    justifyContent: "center",
    alignItems: "center",
    zIndex: 10,
  },
  modalImageContainer: {
    alignItems: "center",
    height: "100%",
    justifyContent: "center",
    width: "100%",
  },
  fullscreenImage: {
    borderRadius: 8,
    height: "70%",
    width: "90%",
  },
  photoDetails: {
    position: "absolute",
    bottom: 40,
    left: 0,
    right: 0,
    padding: 16,
    // backgroundColor moved to dynamic styling
    alignItems: "center",
  },
  photoDetailText: {
    // color moved to dynamic styling
    fontSize: 14,
    fontFamily: "Montserrat-Medium",
    marginBottom: 4,
  },
  // Old video item styles - kept for reference if needed
  videoItem: {
    borderColor: "rgba(0, 0, 0, 0.1)",
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
  videoItemDark: {
    backgroundColor: "#2a2a2a",
  },
  videoItemLight: {
    backgroundColor: "#ffffff",
  },
  videoItemContent: {
    alignItems: "center",
    flexDirection: "row",
  },
  thumbnailContainer: {
    padding: 8,
  },
  videoInfoContainer: {
    flex: 1,
    justifyContent: "center",
    padding: 12,
  },
  videoDate: {
    fontFamily: "Montserrat-Bold",
    fontSize: 14,
    fontWeight: "bold",
    marginBottom: 4,
  },
  videoTime: {
    fontFamily: "Montserrat-Regular",
    fontSize: 13,
    marginBottom: 10,
    opacity: 0.7,
  },
  videoActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10, // Gap between buttons
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
  // Removed shareButton and deleteButton hardcoded colors - using VideoItem/PhotoItem components with theme support
})

export default GlassesRecordingsGallery
