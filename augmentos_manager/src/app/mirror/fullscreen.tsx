import React, {useState, useRef, useEffect, useCallback} from "react"
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  BackHandler,
  Image,
  ToastAndroid,
  Platform,
  Linking,
} from "react-native"
import Icon from "react-native-vector-icons/MaterialIcons"
import {showAlert} from "@/utils/AlertUtils"
import {CameraView, CameraType, useCameraPermissions} from "expo-camera"

import {useFocusEffect, useNavigation} from "@react-navigation/native"
import GlassesDisplayMirrorFullscreen from "@/components/misc/GlassesDisplayMirrorFullscreen"
import {useStatus} from "@/contexts/AugmentOSStatusProvider"
import {useGlassesMirror} from "@/contexts/GlassesMirrorContext"
import {requestFeaturePermissions, PermissionFeatures} from "@/utils/PermissionsUtils"
import RNFS from "react-native-fs"
import {router} from "expo-router"
import {useAppTheme} from "@/utils/useAppTheme"
import { translate } from "@/i18n"

// Request microphone permission for recording
const requestMicrophonePermission = async () => {
  return await requestFeaturePermissions(PermissionFeatures.MICROPHONE)
}

export default function GlassesMirrorFullscreen() {
  const {status} = useStatus()
  const {events} = useGlassesMirror() // From context
  const {theme} = useAppTheme()
  const [permission, requestPermission] = useCameraPermissions()
  const [hasMicrophonePermission, setHasMicrophonePermission] = useState(false)
  const [cameraType, setCameraType] = useState<CameraType>("front")
  const [isRecording, setIsRecording] = useState(false)
  const [recordingTime, setRecordingTime] = useState(0)
  const [recordingPath, setRecordingPath] = useState<string | null>(null)
  const [recordingCount, setRecordingCount] = useState(0)

  const cameraRef = useRef<CameraView | null>(null)
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Helper to check if we have a glasses model name
  const isGlassesConnected = !!status.glasses_info?.model_name

  // Get only the last event
  const lastEvent = events.length > 0 ? events[events.length - 1] : null

  // Check permissions and setup on component mount
  useEffect(() => {
    checkMicrophonePermission()
    // Hide status bar in fullscreen mode
    StatusBar.setHidden(true)
    // Check for existing recordings
    checkRecordings()

    // ;(async () => {
    //   if (!permission?.granted) {
    //     const permissionResult = await requestPermission()
    //     if (!permissionResult.granted) {
    //       showAlert("Permission Required", "Camera permission is needed for recording", undefined, {
    //         iconName: "videocam-off",
    //         iconColor: "#FF3B30",
    //       })
    //       return
    //     }
    //   }
    // })()

    return () => {
      // Show status bar when exiting
      StatusBar.setHidden(false)
      // Clean up recording timer if it exists
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current)
      }
      // Stop recording if it's in progress
      if (isRecording) {
        stopRecording()
      }
    }
  }, [])

  useFocusEffect(
    useCallback(() => {
      checkRecordings()
      return () => {}
    }, []),
  )

  // Count how many recordings are available
  const checkRecordings = async () => {
    try {
      // Define the directory where recordings are stored
      const videoDir =
        Platform.OS === "ios"
          ? `${RNFS.DocumentDirectoryPath}/AugmentOSRecordings`
          : `${RNFS.ExternalDirectoryPath}/AugmentOSRecordings`

      // Check if directory exists, create if not
      const dirExists = await RNFS.exists(videoDir)
      if (!dirExists) {
        await RNFS.mkdir(videoDir)
        setRecordingCount(0)
        return
      }

      // Read directory contents and count videos
      const files = await RNFS.readDir(videoDir)
      const videoFiles = files.filter(file => file.name.endsWith(".mp4"))
      setRecordingCount(videoFiles.length)
    } catch (error) {
      console.error("Error checking recordings:", error)
      setRecordingCount(0)
    }
  }

  // Recording timer effect
  useEffect(() => {
    if (isRecording) {
      // Start a timer that updates every second
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1)
      }, 1000)
    } else {
      // Clear the timer when recording stops
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current)
        recordingTimerRef.current = null
      }
      // Reset the counter
      setRecordingTime(0)
    }

    return () => {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current)
      }
    }
  }, [isRecording])

  // Check microphone permission
  const checkMicrophonePermission = async () => {
    const hasPermission = await requestMicrophonePermission()
    setHasMicrophonePermission(hasPermission)
    return hasPermission
  }

  // Back button handler
  useEffect(() => {
    const backHandler = BackHandler.addEventListener("hardwareBackPress", () => {
      handleExitFullscreen()
      return true
    })

    return () => backHandler.remove()
  }, [])

  // Handle exiting fullscreen mode
  const handleExitFullscreen = () => {
    StatusBar.setHidden(false)
    //router.back() commented bc it routing to home page. 
    router.replace("/mirror")
  }

  // Toggle camera between front and back
  const toggleCamera = () => {
    if (!isRecording) {
      setCameraType(cameraType === "front" ? "back" : "front")    
    } else {
      // Don't allow camera switching during recording
      if (Platform.OS === "android") {
        ToastAndroid.show("Cannot switch camera while recording", ToastAndroid.SHORT)
      } else {
        showAlert("Recording in Progress", "Cannot switch camera while recording")
      }
    }
  }

  // Format seconds into MM:SS format
  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0")
    const secs = (seconds % 60).toString().padStart(2, "0")
    return `${mins}:${secs}`
  }

  // Start recording video
  const startRecording = async () => {
    if (!permission?.granted) {
      const permissionResult = await requestPermission()
      if (!permissionResult.granted) {
        showAlert("Permission Required", "Camera permission is needed for recording", undefined, {
          iconName: "videocam-off",
          iconColor: "#FF3B30",
        })
        return
      }
    }

    if (!hasMicrophonePermission) {
      const hasPermission = await checkMicrophonePermission()
      if (!hasPermission) {
        showAlert("Permission Required", "Microphone permission is needed for recording", undefined, {
          iconName: "mic-off",
          iconColor: "#FF3B30",
        })
        return
      }
    }

    // Ensure we have a directory to save recordings
    const videoDir =
      Platform.OS === "ios"
        ? `${RNFS.DocumentDirectoryPath}/AugmentOSRecordings`
        : `${RNFS.ExternalDirectoryPath}/AugmentOSRecordings`

    // Check if directory exists, create if not
    const dirExists = await RNFS.exists(videoDir)
    if (!dirExists) {
      await RNFS.mkdir(videoDir)
    }

    // Create a unique filename with timestamp
    const timestamp = new Date().getTime()
    const filename = `glasses-recording-${timestamp}.mp4`
    const filePath = `${videoDir}/${filename}`

    if (cameraRef.current) {
      try {
        setIsRecording(true)
        const result = await cameraRef.current.recordAsync({
          maxDuration: 60, // 60 seconds max
          maxFileSize: 30 * 1024 * 1024, // 30MB
          // mute: false, // Record with audio
        })

        // Store video in our app directory
        if (result?.uri) {
          if (Platform.OS === "ios") {
            // On iOS, copy the file
            await RNFS.copyFile(result.uri, filePath)
          } else {
            // On Android, move the file
            const sourceUri = result.uri.startsWith("file://") ? result.uri.substring(7) : result.uri
            await RNFS.moveFile(sourceUri, filePath)
          }

          setRecordingPath(filePath)

          // Update recording count
          await checkRecordings()

          // Show success message
          if (Platform.OS === "android") {
            ToastAndroid.show("Recording saved!", ToastAndroid.LONG)
          } else {
            showAlert(
              "Recording Saved",
              "Your recording has been saved successfully!",
              [
                {
                  text: "View in Gallery",
                  onPress: () => router.back(),
                },
                {text: "Continue Recording"},
              ],
              {
                iconName: "check-circle",
                iconColor: "#4CAF50",
              },
            )
          }
        }
      } catch (error) {
        console.error("Error recording video:", error)
        showAlert("Recording Error", "Failed to record video", undefined, {
          iconName: "error",
          iconColor: "#FF3B30",
        })
      } finally {
        setIsRecording(false)
      }
    }
  }

  // Stop recording video
  const stopRecording = () => {
    if (cameraRef.current && isRecording) {
      cameraRef.current.stopRecording()
      setIsRecording(false)
    }
  }

  // Toggle recording state
  const toggleRecording = () => {
    if (isRecording) {
      stopRecording()
    } else {
      startRecording()
    }
  }

  // Request camera permission if not granted
  const handleRequestPermission = async () => {
    const result = await requestPermission()
    if(!result.canAskAgain){
      showAlert(
                        translate("mirror:cameraPermissionRequired"),
                        translate("mirror:cameraPermissionRequiredMessage"),
                        [
                          {
                            text: translate("common:cancel"),
                            style: "cancel",
                          },
                          {
                            text: translate("mirror:openSettings"),
                            onPress: () => Linking.openSettings(),
                          },
                          
                        ],
                      )
    }

    return result.granted
  }

  return (
    <View style={[styles.fullscreenContainer, { backgroundColor: theme.colors.fullscreenBackground }]}>
      {isGlassesConnected && lastEvent ? (
        <>
          {/* Camera feed */}
          {permission?.granted ? (
            <CameraView
              ref={cameraRef}
              style={styles.cameraBackground}
              facing={cameraType}
              mode="video"
              enableTorch={false}
            />
          ) : (
            <View style={[styles.fullscreenBackground, { backgroundColor: theme.colors.galleryBackground }]}>
              <Text style={[styles.cameraPermissionText, { color: theme.colors.icon }]}>Camera permission needed for fullscreen mode</Text>
              <TouchableOpacity style={[styles.permissionButton, { backgroundColor: theme.colors.permissionButton }]} onPress={handleRequestPermission}>
                <Text style={[styles.permissionButtonText, { color: theme.colors.icon }]}>Grant Permission</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Overlay the glasses display content */}
          {permission?.granted && (
            <View style={styles.fullscreenOverlay}>
              <GlassesDisplayMirrorFullscreen layout={lastEvent.layout} fallbackMessage="Unknown layout data" />
            </View>
          )}

          {/* Fullscreen exit button */}
          <TouchableOpacity style={[styles.exitFullscreenButton, { backgroundColor: theme.colors.palette.secondary200 }]} onPress={handleExitFullscreen}>
            <Text style={[styles.exitFullscreenText, { color: theme.colors.icon }]}>Exit</Text>
          </TouchableOpacity>

          {/* Camera flip button */}
          {permission?.granted && (
            <TouchableOpacity style={[styles.flipCameraButton, { backgroundColor: theme.colors.palette.secondary200 }]} onPress={toggleCamera}>
              <Icon name="flip-camera-ios" size={28} color={theme.colors.icon} />
            </TouchableOpacity>
          )}

          {/* Recording button */}
          {/* TEMPORARILY: COMMENT OUT THE RECORD BUTTON UNTIL THIS FEATURE IS COMPLETE */}
          {/* {permission?.granted && (
            <View style={styles.recordingContainer}>
              <TouchableOpacity
                style={[
                  styles.recordButton,
                  isRecording ? styles.recordingActive : {}
                ]}
                onPress={toggleRecording}
              >
                {isRecording ? (
                  <Icon name="stop" size={36} color="white" />
                ) : (
                  <View style={styles.recordButtonInner} />
                )}
              </TouchableOpacity>

              {isRecording && (
                <Text style={styles.recordingTimer}>
                  {formatTime(recordingTime)}
                </Text>
              )}
            </View>
          )} */}

          {/* Gallery button - goes back to main screen to view gallery */}
          {!isRecording && (
            <TouchableOpacity style={[styles.videosButton, { backgroundColor: theme.colors.palette.secondary200 }]} onPress={() => router.back()}>
              <Icon name="photo-library" size={24} color={theme.colors.icon} />
              {recordingCount > 0 && (
                <View style={[styles.badgeContainer, { backgroundColor: theme.colors.badgeBackground, borderColor: theme.colors.fullscreenOverlay }]}>
                  <Text style={[styles.badgeText, { color: theme.colors.icon }]}>{recordingCount}</Text>
                </View>
              )}
            </TouchableOpacity>
          )}
        </>
      ) : (
        <View style={[styles.fallbackContainer, { backgroundColor: theme.colors.galleryBackground }]}>
          <Text style={[styles.fallbackText, { color: theme.colors.icon }]}>
            {!isGlassesConnected ? "Connect glasses to use the Glasses Mirror" : "No display events available"}
          </Text>
          <TouchableOpacity style={[styles.exitFullscreenButton, { backgroundColor: theme.colors.palette.secondary200 }]} onPress={handleExitFullscreen}>
            <Text style={[styles.exitFullscreenText, { color: theme.colors.icon }]}>Back</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  fullscreenContainer: {
    flex: 1,
    padding: 0,
    // backgroundColor moved to dynamic styling
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1000,
  },
  cameraBackground: {
    position: "absolute",
    width: "100%",
    height: "100%",
    aspectRatio: 1,
    alignSelf: "center",
  },
  fullscreenBackground: {
    position: "absolute",
    width: "100%",
    height: "100%",
    // backgroundColor moved to dynamic styling
    justifyContent: "center",
    alignItems: "center",
  },
  cameraPermissionText: {
    // color moved to dynamic styling
    fontSize: 16,
    fontFamily: "Montserrat-Regular",
    textAlign: "center",
    marginBottom: 20,
  },
  permissionButton: {
    // backgroundColor moved to dynamic styling
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
  },
  permissionButtonText: {
    // color moved to dynamic styling
    fontSize: 16,
    fontFamily: "Montserrat-Bold",
  },
  fullscreenOverlay: {
    position: "absolute",
    width: "100%",
    height: "100%",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "transparent",
    padding: 40,
    zIndex: 10,
  },
  fullscreenDisplayContainer: {
    padding: 0,
    backgroundColor: "transparent",
  },
  exitFullscreenButton: {
    position: "absolute",
    top: 40,
    right: 20,
    // backgroundColor moved to dynamic styling
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 30,
    zIndex: 20,
  },
  exitFullscreenText: {
    // color moved to dynamic styling
    fontSize: 16,
    fontFamily: "Montserrat-Bold",
  },
  flipCameraButton: {
    position: "absolute",
    top: 40,
    left: 20,
    // backgroundColor moved to dynamic styling
    padding: 12,
    borderRadius: 50,
    zIndex: 20,
  },
  recordingContainer: {
    position: "absolute",
    bottom: 40,
    alignSelf: "center",
    alignItems: "center",
    zIndex: 20,
  },
  recordButton: {
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: "rgba(255, 0, 0, 0.8)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 4,
    borderColor: "white",
  },
  recordButtonInner: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "white",
  },
  recordingActive: {
    backgroundColor: "rgba(255, 0, 0, 0.9)",
    borderColor: "white",
  },
  recordingTimer: {
    color: "white",
    fontSize: 16,
    fontFamily: "Montserrat-Bold",
    marginTop: 10,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    paddingVertical: 5,
    paddingHorizontal: 15,
    borderRadius: 20,
  },
  videosButton: {
    position: "absolute",
    bottom: 40,
    right: 20,
    // backgroundColor moved to dynamic styling
    padding: 12,
    borderRadius: 50,
    zIndex: 20,
  },
  badgeContainer: {
    position: "absolute",
    top: -5,
    right: -5,
    // backgroundColor moved to dynamic styling
    borderRadius: 12,
    minWidth: 24,
    height: 24,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    // borderColor moved to dynamic styling
  },
  badgeText: {
    // color moved to dynamic styling
    fontSize: 12,
    fontFamily: "Montserrat-Bold",
    fontWeight: "bold",
  },
  fallbackContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    // backgroundColor moved to dynamic styling
  },
  fallbackText: {
    // color moved to dynamic styling
    fontSize: 18,
    fontFamily: "Montserrat-Regular",
    textAlign: "center",
    marginHorizontal: 20,
    marginBottom: 20,
  },
})
