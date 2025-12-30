import CoreModule from "core"
import {useState} from "react"
import {View} from "react-native"
import Toast from "react-native-toast-message"

import {Screen, Header, Text} from "@/components/ignite"
import ActionButton from "@/components/ui/ActionButton"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/utils/useAppTheme"

export default function BufferDebugPage() {
  const {theme} = useAppTheme()
  const {goBack} = useNavigationHistory()
  const [isBufferRecording, setIsBufferRecording] = useState(false)
  const [isVideoRecording, setIsVideoRecording] = useState(false)
  const [videoRequestId, setVideoRequestId] = useState<string | null>(null)

  const handleStartStop = async () => {
    if (isBufferRecording) {
      await CoreModule.stopBufferRecording()
      setIsBufferRecording(false)
      Toast.show({
        type: "success",
        text1: "Buffer Recording Stopped",
        position: "bottom",
        visibilityTime: 2000,
      })
    } else {
      await CoreModule.startBufferRecording()
      setIsBufferRecording(true)
      Toast.show({
        type: "success",
        text1: "Buffer Recording Started",
        text2: "Recording last 30 seconds continuously",
        position: "bottom",
        visibilityTime: 2000,
      })
    }
  }

  const handleSave = async (seconds: number) => {
    if (!isBufferRecording) {
      Toast.show({
        type: "error",
        text1: "Buffer not recording",
        text2: "Start buffer recording first",
        position: "bottom",
        visibilityTime: 2000,
      })
      return
    }

    const requestId = `buffer_${Date.now()}`
    await CoreModule.sendSaveBufferVideo(requestId, seconds)
    Toast.show({
      type: "success",
      text1: "Saving buffer video",
      text2: `Last ${seconds} seconds will be saved`,
      position: "bottom",
      visibilityTime: 3000,
    })
  }

  const handleVideoStartStop = async () => {
    if (isVideoRecording) {
      if (videoRequestId) {
        await CoreModule.sendStopVideoRecording(videoRequestId)
        setIsVideoRecording(false)
        setVideoRequestId(null)
        Toast.show({
          type: "success",
          text1: "Video Recording Stopped",
          position: "bottom",
          visibilityTime: 2000,
        })
      }
    } else {
      const requestId = `video_${Date.now()}`
      setVideoRequestId(requestId)
      await CoreModule.sendStartVideoRecording(requestId, true)
      setIsVideoRecording(true)
      Toast.show({
        type: "success",
        text1: "Video Recording Started",
        text2: "Recording standard video...",
        position: "bottom",
        visibilityTime: 2000,
      })
    }
  }

  return (
    <Screen preset="scroll">
      <Header title="Camera Debug" leftIcon="chevron-left" onLeftPress={goBack} />

      <Spacer height={theme.spacing.s8} />

      <View style={{flex: 1, gap: theme.spacing.s4}}>
        <View
          style={{
            padding: theme.spacing.s6,
            backgroundColor: theme.colors.surface,
            borderRadius: theme.spacing.s3,
            alignItems: "center",
          }}>
          <Text style={{fontSize: 48, marginBottom: theme.spacing.s3}}>{isBufferRecording ? "🔴" : "⏸️"}</Text>
          <Text
            style={{
              fontSize: 18,
              fontWeight: "bold",
              color: theme.colors.text,
              marginBottom: theme.spacing.s2,
            }}>
            {isBufferRecording ? "Buffer Recording Active" : "Buffer Recording Stopped"}
          </Text>
          <Text
            style={{
              fontSize: 14,
              color: theme.colors.textDim,
              textAlign: "center",
            }}>
            {isBufferRecording
              ? "Continuously recording the last 30 seconds in a circular buffer"
              : "Press start to begin recording to buffer"}
          </Text>
        </View>

        <ActionButton
          label={isBufferRecording ? "Stop Buffer Recording" : "Start Buffer Recording"}
          variant={isBufferRecording ? "destructive" : "primary"}
          onPress={handleStartStop}
        />

        <View style={{opacity: isBufferRecording ? 1 : 0.5}}>
          <Text
            style={{
              fontSize: 16,
              fontWeight: "600",
              color: theme.colors.text,
              marginBottom: theme.spacing.s3,
              marginTop: theme.spacing.s4,
            }}>
            Save Buffer
          </Text>

          <View style={{gap: theme.spacing.s3}}>
            <ActionButton
              label="Save Last 30 Seconds"
              variant="secondary"
              disabled={!isBufferRecording}
              onPress={() => handleSave(30)}
            />

            <ActionButton
              label="Save Last 15 Seconds"
              variant="secondary"
              disabled={!isBufferRecording}
              onPress={() => handleSave(15)}
            />

            <ActionButton
              label="Save Last 10 Seconds"
              variant="secondary"
              disabled={!isBufferRecording}
              onPress={() => handleSave(10)}
            />
          </View>
        </View>

        {/* Video Recording Section */}
        <View
          style={{
            padding: theme.spacing.s6,
            backgroundColor: theme.colors.surface,
            borderRadius: theme.spacing.s3,
            alignItems: "center",
          }}>
          <Text style={{fontSize: 48, marginBottom: theme.spacing.s3}}>{isVideoRecording ? "🔴" : "📹"}</Text>
          <Text
            style={{
              fontSize: 18,
              fontWeight: "bold",
              color: theme.colors.text,
              marginBottom: theme.spacing.s2,
            }}>
            {isVideoRecording ? "Recording Video" : "Standard Video Recording"}
          </Text>
          <Text
            style={{
              fontSize: 14,
              color: theme.colors.textDim,
              textAlign: "center",
              marginBottom: theme.spacing.s4,
            }}>
            {isVideoRecording ? "Recording standard video to file..." : "Record a regular video (not buffer mode)"}
          </Text>

          <ActionButton
            label={isVideoRecording ? "Stop Video Recording" : "Start Video Recording"}
            variant={isVideoRecording ? "destructive" : "secondary"}
            onPress={handleVideoStartStop}
          />
        </View>

        <View
          style={{
            padding: theme.spacing.s4,
            backgroundColor: theme.colors.surface,
            borderRadius: theme.spacing.s3,
            marginTop: theme.spacing.s4,
          }}>
          <Text style={{fontSize: 12, color: theme.colors.textDim}}>
            <Text style={{fontWeight: "bold"}}>Recording Modes:</Text>
            {"\n\n"}
            <Text style={{fontWeight: "bold"}}>Buffer Mode:</Text>
            {"\n"}• Continuously records last 30 seconds
            {"\n"}• Save clips from the buffer anytime
            {"\n"}• Perfect for capturing moments you just missed
            {"\n\n"}
            <Text style={{fontWeight: "bold"}}>Standard Video:</Text>
            {"\n"}• Records from start to stop
            {"\n"}• Saves complete video file
            {"\n"}• Traditional video recording
          </Text>
        </View>
      </View>
    </Screen>
  )
}
