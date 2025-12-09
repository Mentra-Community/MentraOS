import {CameraType, CameraView, useCameraPermissions} from "expo-camera"
import {useFocusEffect} from "expo-router"
import {useCallback, useEffect, useRef, useState} from "react"
import {
  BackHandler,
  Platform,
  StatusBar,
  TextStyle,
  ToastAndroid,
  TouchableOpacity,
  View,
  ViewStyle,
} from "react-native"
import RNFS from "react-native-fs"
import {useSafeAreaInsets} from "react-native-safe-area-context"
import Icon from "react-native-vector-icons/MaterialIcons"

import {Text} from "@/components/ignite"
import GlassesDisplayMirror from "@/components/mirror/GlassesDisplayMirror"
import {SimulatedGlassesControls} from "@/components/mirror/SimulatedGlassesControls"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import {PermissionFeatures, requestFeaturePermissions} from "@/utils/PermissionsUtils"
import {useAppTheme} from "@/utils/useAppTheme"

import {DeviceTypes} from "@/../../cloud/packages/types/src"

// Request microphone permission for recording
const requestMicrophonePermission = async () => {
  return await requestFeaturePermissions(PermissionFeatures.MICROPHONE)
}

export default function GlassesMirrorFullscreen() {
  const {theme, themed} = useAppTheme()
  const insets = useSafeAreaInsets()
  const [permission, requestPermission] = useCameraPermissions()
  const [hasMicrophonePermission, setHasMicrophonePermission] = useState(false)
  const [cameraType, setCameraType] = useState<CameraType>("front")
  const [isRecording, setIsRecording] = useState(false)
  const [_recordingTime, setRecordingTime] = useState(0)
  const [_recordingPath, setRecordingPath] = useState<string | null>(null)
  const [recordingCount, setRecordingCount] = useState(0)
  const [isCameraOn, setIsCameraOn] = useState(true)
  const {goBack} = useNavigationHistory()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)

  const cameraRef = useRef<CameraView | null>(null)
  const recordingTimerRef = useRef<number | null>(null)

  // Check permissions and setup on component mount
  useEffect(() => {
    checkMicrophonePermission()
    // Hide status bar in fullscreen mode
    StatusBar.setHidden(true)
    // Check for existing recordings
    checkRecordings()

    // If no camera permission, go back to mirror tab
    // This should not happen anymore since we check permissions before navigating here
    if (!permission?.granted) {
      // router.replace("/mirror")
      return
    }

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
  }, [permission])

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
    goBack()
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

  // Toggle camera on/off
  const toggleCameraOnOff = () => {
    if (isRecording) {
      // Don't allow turning camera off while recording
      if (Platform.OS === "android") {
        ToastAndroid.show("Cannot turn off camera while recording", ToastAndroid.SHORT)
      } else {
        showAlert("Recording in Progress", "Cannot turn off camera while recording")
      }
      return
    }
    setIsCameraOn(!isCameraOn)
  }

  // Format seconds into MM:SS format

  // Start recording video
  const _startRecording = async () => {
    if (!isCameraOn) {
      showAlert("Camera Off", "Turn on the camera to start recording", undefined, {
        iconName: "videocam-off",
        iconColor: "#FF3B30",
      })
      return
    }

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
                  onPress: () => goBack(),
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

  return (
    <View style={themed($fullscreenContainer)}>
      <View style={$contentWrapper}>
        {/* Camera feed - only render if camera is on */}
        {isCameraOn && (
          <CameraView ref={cameraRef} style={$cameraBackground} facing={cameraType} mode="video" enableTorch={false} />
        )}

        {/* Dark background when camera is off */}
        {!isCameraOn && <View style={themed($cameraOff)} />}

        {/* Overlay the glasses display content */}
        <View style={$fullscreenOverlay}>
          <GlassesDisplayMirror fullscreen={true} />
        </View>

        {/* Fullscreen exit button */}
        <TouchableOpacity
          style={[themed($exitFullscreenButton), {top: insets.top + 20}]}
          onPress={handleExitFullscreen}>
          <Text style={themed($exitFullscreenText)}>Exit</Text>
        </TouchableOpacity>

        {/* Camera toggle on/off button */}
        <TouchableOpacity style={[themed($cameraToggleButton), {top: insets.top + 20}]} onPress={toggleCameraOnOff}>
          <Icon name={isCameraOn ? "videocam" : "videocam-off"} size={28} color={theme.colors.icon} />
        </TouchableOpacity>

        {/* Camera flip button - only show when camera is on */}
        {isCameraOn && (
          <TouchableOpacity style={[themed($flipCameraButton), {top: insets.top + 20}]} onPress={toggleCamera}>
            <Icon name="flip-camera-ios" size={28} color={theme.colors.icon} />
          </TouchableOpacity>
        )}

        {/* Recording button */}
        {/* TEMPORARILY: COMMENT OUT THE RECORD BUTTON UNTIL THIS FEATURE IS COMPLETE */}
        {/* {permission?.granted && (
          <View style={$recordingContainer}>
            <TouchableOpacity
              style={[
                $recordButton,
                isRecording ? $recordingActive : {}
              ]}
              onPress={toggleRecording}
            >
              {isRecording ? (
                <Icon name="stop" size={36} color="white" />
              ) : (
                <View style={$recordButtonInner} />
              )}
            </TouchableOpacity>

            {isRecording && (
              <Text style={$recordingTimer}>
                {formatTime(recordingTime)}
              </Text>
            )}
          </View>
        )} */}

        {/* Gallery button - goes back to main screen to view gallery */}
        {!isRecording && (
          <TouchableOpacity style={[themed($videosButton), {bottom: insets.bottom + 40}]} onPress={() => goBack()}>
            <Icon name="photo-library" size={24} color={theme.colors.icon} />
            {recordingCount > 0 && (
              <View style={themed($badgeContainer)}>
                <Text style={themed($badgeText)}>{recordingCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        )}

        {/* Simulated glasses controls - only show for simulated glasses */}
        {defaultWearable?.includes(DeviceTypes.SIMULATED) && <SimulatedGlassesControls />}
      </View>
    </View>
  )
}

const $fullscreenContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  flex: 1,
  padding: 0,
  backgroundColor: colors.palette.black,
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 1000,
})

const $contentWrapper: ViewStyle = {
  flex: 1,
}

const $cameraBackground: ViewStyle = {
  alignSelf: "center",
  aspectRatio: 1,
  height: "100%",
  position: "absolute",
  width: "100%",
}

const $cameraOff: ThemedStyle<ViewStyle> = ({colors}) => ({
  alignSelf: "center",
  aspectRatio: 1,
  height: "100%",
  position: "absolute",
  width: "100%",
  backgroundColor: colors.palette.black,
})

const $fullscreenOverlay: ViewStyle = {
  alignItems: "center",
  backgroundColor: "transparent",
  height: "100%",
  justifyContent: "center",
  padding: 40,
  position: "absolute",
  width: "100%",
  zIndex: 10,
}

const $exitFullscreenButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  position: "absolute",
  right: 20,
  backgroundColor: colors.palette.secondary200,
  paddingVertical: 10,
  paddingHorizontal: 20,
  borderRadius: 30,
  zIndex: 20,
})

const $exitFullscreenText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.icon,
  fontSize: 16,
  fontFamily: "Montserrat-Bold",
})

const $cameraToggleButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  position: "absolute",
  left: 20,
  backgroundColor: colors.palette.secondary200,
  padding: 12,
  borderRadius: 50,
  zIndex: 20,
})

const $flipCameraButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  position: "absolute",
  left: 80,
  backgroundColor: colors.palette.secondary200,
  padding: 12,
  borderRadius: 50,
  zIndex: 20,
})

const $videosButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  position: "absolute",
  right: 20,
  backgroundColor: colors.palette.secondary200,
  padding: 12,
  borderRadius: 50,
  zIndex: 20,
})

const $badgeContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  position: "absolute",
  top: -5,
  right: -5,
  backgroundColor: colors.palette.angry600,
  borderRadius: 12,
  minWidth: 24,
  height: 24,
  justifyContent: "center",
  alignItems: "center",
  borderWidth: 2,
  borderColor: colors.border,
})

const $badgeText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.icon,
  fontSize: 12,
  fontFamily: "Montserrat-Bold",
  fontWeight: "bold",
})
