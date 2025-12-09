import CoreModule from "core"
import {useEffect, useState} from "react"
import {ScrollView, TextInput, TextStyle, TouchableOpacity, View, ViewStyle} from "react-native"

import bridge from "@/bridge/MantleBridge"
import {Text} from "@/components/ignite"
import {PillButton} from "@/components/ignite"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {RouteButton} from "@/components/ui/RouteButton"
import {useCoreStatus} from "@/contexts/CoreStatusProvider"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n/translate"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import {MOCK_CONNECTION} from "@/utils/Constants"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {useAppTheme} from "@/utils/useAppTheme"

import {Capabilities, getModelCapabilities} from "@/../../cloud/packages/types/src"

// Nex Interface Version - Single source of truth
export const NEX_INTERFACE_VERSION = "1.0.0"

// Pattern Preview Component (copied from DeviceSettings)
interface PatternPreviewProps {
  imageType: string
  imageSize: string
  isDark?: boolean
  showDualLayout?: boolean
}

const PatternPreview = ({imageType, imageSize, isDark = false, showDualLayout = false}: PatternPreviewProps) => {
  const previewSize = 80
  const primaryColor = isDark ? "#000000" : "#FFFFFF"
  const secondaryColor = isDark ? "#CCCCCC" : "#666666"

  const renderPattern = (width: number, height: number) => {
    switch (imageType) {
      case "pattern":
        // Horizontal stripe pattern
        const stripeCount = Math.max(4, Math.floor(height / 10))
        return (
          <View style={{width, height}}>
            {Array.from({length: stripeCount}, (_, i) => (
              <View
                key={i}
                style={{
                  height: height / stripeCount,
                  backgroundColor: i % 2 === 0 ? primaryColor : secondaryColor,
                }}
              />
            ))}
          </View>
        )

      case "checkerboard":
        const squareSize = Math.max(width / 8, height / 8)
        const cols = Math.floor(width / squareSize)
        const rows = Math.floor(height / squareSize)
        return (
          <View style={{width, height}}>
            {Array.from({length: rows}, (_, row) => (
              <View key={row} style={{flexDirection: "row"}}>
                {Array.from({length: cols}, (_, col) => {
                  const isEven = (row + col) % 2 === 0
                  return (
                    <View
                      key={col}
                      style={{
                        width: squareSize,
                        height: squareSize,
                        backgroundColor: isEven ? primaryColor : secondaryColor,
                      }}
                    />
                  )
                })}
              </View>
            ))}
          </View>
        )

      case "solid":
      default:
        return (
          <View
            style={{
              width,
              height,
              backgroundColor: primaryColor,
            }}
          />
        )
    }
  }

  if (showDualLayout) {
    // Parse dimensions from imageSize string
    const [originalWidth, originalHeight] = imageSize.split("x").map(Number)

    // Proper sizing to match reference
    const originalDisplaySize = Math.min(150, Math.max(80, originalWidth || 80))

    // Display version should maintain 600x440 aspect ratio (1.36:1)
    const displayWidth = 300 // Wide rectangle like in reference
    const displayHeight = 220 // 600/440 = 1.36 ratio, so 300/220 ≈ 1.36

    return (
      <View
        style={{
          alignItems: "center",
          paddingVertical: 20,
          paddingHorizontal: 16,
          backgroundColor: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.02)",
          borderRadius: 12,
          marginVertical: 8,
        }}>
        <Text
          style={{
            fontSize: 16,
            fontWeight: "600",
            color: isDark ? "#FFFFFF" : "#000000",
            textAlign: "center",
            marginBottom: 20,
            letterSpacing: 0.5,
          }}>
          {/* MentraOS Connected */}
          {"/// MentraOS Connected \\\\\\"}
        </Text>

        <Text
          style={{
            fontSize: 14,
            color: isDark ? "#CCCCCC" : "#666666",
            marginBottom: 16,
            textAlign: "center",
          }}>
          Received Image: {imageSize} (Display: 600x440)
        </Text>

        {/* Original Image Section */}
        <View style={{alignItems: "center", marginBottom: 20}}>
          <Text
            style={{
              fontSize: 13,
              color: isDark ? "#CCCCCC" : "#666666",
              marginBottom: 12,
              fontWeight: "500",
            }}>
            Original: {imageSize}
          </Text>
          <View
            style={{
              borderWidth: 2,
              borderColor: isDark ? "#555555" : "#DDDDDD",
              borderRadius: 12,
              overflow: "hidden",
              backgroundColor: isDark ? "#2A2A2A" : "#FFFFFF",
              padding: 12,
              shadowColor: "#000",
              shadowOffset: {width: 0, height: 2},
              shadowOpacity: 0.1,
              shadowRadius: 4,
              elevation: 3,
            }}>
            {renderPattern(originalDisplaySize, originalDisplaySize)}
          </View>
        </View>

        {/* Display Version Section */}
        <View style={{alignItems: "center"}}>
          <Text
            style={{
              fontSize: 13,
              color: isDark ? "#CCCCCC" : "#666666",
              marginBottom: 12,
              fontWeight: "500",
            }}>
            Display Version (600x440):
          </Text>
          <View
            style={{
              borderWidth: 2,
              borderColor: isDark ? "#555555" : "#DDDDDD",
              borderRadius: 12,
              overflow: "hidden",
              backgroundColor: isDark ? "#2A2A2A" : "#FFFFFF",
              padding: 8,
              shadowColor: "#000",
              shadowOffset: {width: 0, height: 2},
              shadowOpacity: 0.1,
              shadowRadius: 4,
              elevation: 3,
              width: displayWidth + 16,
              height: displayHeight + 16,
            }}>
            {/* Full 600x440 display area */}
            <View
              style={{
                width: displayWidth,
                height: displayHeight,
                backgroundColor: "#FFFFFF",
                position: "relative",
              }}>
              {/* Original image size within the display */}
              <View
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: (originalWidth || previewSize) * (displayWidth / 600),
                  height: (originalHeight || previewSize) * (displayHeight / 440),
                }}>
                {renderPattern(
                  (originalWidth || previewSize) * (displayWidth / 600),
                  (originalHeight || previewSize) * (displayHeight / 440),
                )}
              </View>
            </View>
          </View>
          <Text
            style={{
              fontSize: 12,
              color: isDark ? "#999999" : "#888888",
              marginTop: 12,
              textAlign: "center",
              fontWeight: "400",
            }}>
            Display: 600x440 pixels
          </Text>
        </View>
      </View>
    )
  }

  // Original single preview layout
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: isDark ? "#444444" : "#CCCCCC",
        borderRadius: 8,
        overflow: "hidden",
        backgroundColor: isDark ? "#1A1A1A" : "#FFFFFF",
      }}>
      {renderPattern(previewSize, previewSize)}
    </View>
  )
}

// Interface for BLE command objects
interface BleCommand {
  command?: string
  commandText?: string
  timestamp?: number
}

export default function NexDeveloperSettings() {
  const {theme, themed} = useAppTheme()
  const {status} = useCoreStatus()
  const {push} = useNavigationHistory()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const glassesConnected = useGlassesStore(state => state.connected)
  const glassesModelName = useGlassesStore(state => state.modelName)
  const features: Capabilities = getModelCapabilities(defaultWearable)

  // Mentra Nex BLE test state variables
  const [text, setText] = useState("Hello World")
  const [positionX, setPositionX] = useState("0")
  const [positionY, setPositionY] = useState("0")
  const [size, setSize] = useState("20")
  const [selectedImageSize, setSelectedImageSize] = useState("32x32")
  const [selectedImageType, setSelectedImageType] = useState("solid")
  const [commandSender, setCommandSender] = useState<BleCommand | null>(null)
  const [commandReceiver, setCommandReceiver] = useState<BleCommand | null>(null)

  // Heartbeat Console state variables
  const [lastHeartbeatSent, setLastHeartbeatSent] = useState<number | null>(null)
  const [lastHeartbeatReceived, setLastHeartbeatReceived] = useState<number | null>(null)

  // LC3 Audio Control state
  const [lc3AudioEnabled, setLc3AudioEnabled] = useState(true)

  // Get both protobuf versions from core status
  const protobufSchemaVersion = status.core_info.protobuf_schema_version || "Unknown"
  const glassesProtobufVersion = status.core_info.glasses_protobuf_version || "Unknown"

  // BLE Command display state variables
  const [showFullSenderCommand, setShowFullSenderCommand] = useState(false)
  const [showFullReceiverCommand, setShowFullReceiverCommand] = useState(false)

  // Mentra Nex BLE test event handlers
  useEffect(() => {
    const handleCommandFromSender = (sender: BleCommand) => {
      console.log("handleCommandFromSender:", sender)
      setCommandSender(sender)
    }

    const handleCommandFromReceiver = (receiver: BleCommand) => {
      console.log("handleCommandFromReceiver:", receiver)
      setCommandReceiver(receiver)
    }

    const handleHeartbeatSent = (data: {timestamp: number}) => {
      console.log("handleHeartbeatSent:", data)
      setLastHeartbeatSent(data.timestamp)
    }

    const handleHeartbeatReceived = (data: {timestamp: number}) => {
      console.log("handleHeartbeatReceived:", data)
      setLastHeartbeatReceived(data.timestamp)
    }

    if (!MOCK_CONNECTION) {
      GlobalEventEmitter.on("send_command_to_ble", handleCommandFromSender)
      GlobalEventEmitter.on("receive_command_from_ble", handleCommandFromReceiver)
      GlobalEventEmitter.on("heartbeat_sent", handleHeartbeatSent)
      GlobalEventEmitter.on("heartbeat_received", handleHeartbeatReceived)
    }

    return () => {
      if (!MOCK_CONNECTION) {
        GlobalEventEmitter.removeListener("send_command_to_ble", handleCommandFromSender)
        GlobalEventEmitter.removeListener("receive_command_from_ble", handleCommandFromReceiver)
        GlobalEventEmitter.removeListener("heartbeat_sent", handleHeartbeatSent)
        GlobalEventEmitter.removeListener("heartbeat_received", handleHeartbeatReceived)
      }
    }
  }, [])

  // Mentra Nex BLE test handlers
  const onSendTextClick = async () => {
    if (glassesConnected) {
      if (text === "" || positionX === null || positionY === null || size === null) {
        showAlert("Please fill all the fields", "Please fill all the fields", [
          {
            text: "OK",
            onPress: () => {},
          },
        ])
        return
      }
      await CoreModule.displayText({
        text,
        x: parseInt(positionX, 0),
        y: parseInt(positionY, 0),
        size: parseInt(size, 10),
      })
    } else {
      showAlert("Please connect to the device", "Please connect to the device", [
        {
          text: "OK",
          onPress: () => {},
        },
      ])
      return
    }
  }

  const onRestTextClick = async () => {
    setText("Hello World")
    setPositionX("0")
    setPositionY("0")
    setSize("20")
  }

  const onSendImageClick = async () => {
    if (glassesConnected) {
      await CoreModule.displayImage(selectedImageType, selectedImageSize)
    } else {
      showAlert("Please connect to the device", "Please connect to the device", [
        {
          text: "OK",
          onPress: () => {},
        },
      ])
      return
    }
  }

  const onClearDisplayClick = async () => {
    if (glassesConnected) {
      await CoreModule.clearDisplay()
    } else {
      showAlert("Please connect to the device", "Please connect to the device", [
        {
          text: "OK",
          onPress: () => {},
        },
      ])
      return
    }
  }

  const onLc3AudioToggle = async (enabled: boolean) => {
    setLc3AudioEnabled(enabled)
    if (glassesConnected) {
      await bridge.setLc3AudioEnabled(enabled)
    }
  }

  // Helper function to format timestamps
  const formatTimestamp = (timestamp: number | null): string => {
    if (!timestamp) return "Never"
    const date = new Date(timestamp)
    return date.toLocaleTimeString()
  }

  return (
    <ScrollView style={themed($container)} showsVerticalScrollIndicator={false}>
      <View style={themed($content)}>
        {/* Header */}
        <View style={themed($headerSection)}>
          <Text style={themed($title)}>Nex Developer Settings</Text>
          <Text style={themed($subtitle)}>
            Advanced developer tools and debugging features for smart glasses development
          </Text>
          <View style={themed($versionContainer)}>
            <Text style={themed($versionBadge)}>Interface v{NEX_INTERFACE_VERSION}</Text>
            <Text style={themed($protobufVersionBadge)}>App Protobuf {protobufSchemaVersion.split(" | ")[0]}</Text>
            <Text style={themed($glassesProtobufVersionBadge)}>
              Glasses Protobuf {glassesProtobufVersion.split(" | ")[0]}
            </Text>
          </View>
        </View>

        {/* Screen Settings for binocular glasses */}
        {defaultWearable && features?.display?.count && features?.display?.count > 1 && (
          <View style={themed($settingsGroup)}>
            <Text style={themed($sectionTitle)}>Display Settings</Text>
            <RouteButton
              label={translate("settings:screenSettings")}
              subtitle={translate("settings:screenDescription")}
              onPress={() => push("/settings/screen")}
            />
          </View>
        )}

        {/* Mentra Nex BLE Test Section - Only show when connected to Mentra Nex */}
        {glassesModelName === "Mentra Nex" ? (
          <>
            {/* Custom Display Text Settings */}
            <View style={themed($settingsGroup)}>
              <Text style={themed($sectionTitle)}>Custom Display Text</Text>
              <Text style={themed($description)}>Set the display text for the Mentra Nex with text, x, y and size</Text>

              <TextInput
                style={themed($textInput)}
                placeholder="text"
                placeholderTextColor={theme.colors.textDim}
                value={text}
                onChangeText={setText}
                maxLength={100}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="default"
                editable={true}
              />
              <View style={$inputRow}>
                <TextInput
                  style={[themed($textInput), $smallInput]}
                  placeholder="x"
                  placeholderTextColor={theme.colors.textDim}
                  value={positionX}
                  onChangeText={setPositionX}
                  autoCapitalize="none"
                  maxLength={3}
                  autoCorrect={false}
                  keyboardType="phone-pad"
                  editable={true}
                />
                <TextInput
                  style={[themed($textInput), $smallInput]}
                  placeholder="y"
                  placeholderTextColor={theme.colors.textDim}
                  value={positionY}
                  maxLength={3}
                  onChangeText={setPositionY}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="phone-pad"
                  editable={true}
                />
                <TextInput
                  style={[themed($textInput), $smallInput]}
                  placeholder="size"
                  placeholderTextColor={theme.colors.textDim}
                  value={size}
                  onChangeText={setSize}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={2}
                  keyboardType="phone-pad"
                  editable={true}
                />
              </View>
              <View style={$buttonRow}>
                <PillButton
                  text="Send Text"
                  variant="primary"
                  onPress={onSendTextClick}
                  disabled={false}
                  buttonStyle={$primaryButton}
                />
                <PillButton
                  text="Reset Settings"
                  variant="icon"
                  onPress={onRestTextClick}
                  disabled={false}
                  buttonStyle={$secondaryButton}
                />
              </View>
            </View>

            {/* Send Test Image */}
            <View style={themed($settingsGroup)}>
              <Text style={themed($sectionTitle)}>Send Test Image</Text>
              <Text style={themed($description)}>Send a test bitmap image to BLE with selected size</Text>

              {/* Size Selection */}
              <View style={$selectionSection}>
                <Text style={themed($label)}>Image Size:</Text>
                <View style={$buttonGrid}>
                  {[
                    {label: "8×8", value: "8x8"},
                    {label: "16×16", value: "16x16"},
                    {label: "32×32", value: "32x32"},
                    {label: "160×160", value: "160x160"},
                    {label: "240×240", value: "240x240"},
                  ].map(size => (
                    <PillButton
                      key={size.value}
                      text={size.label}
                      variant={selectedImageSize === size.value ? "primary" : "secondary"}
                      onPress={() => setSelectedImageSize(size.value)}
                      buttonStyle={$gridButton}
                    />
                  ))}
                </View>
              </View>

              {/* Image Selection */}
              <View style={$selectionSection}>
                <Text style={themed($label)}>Test Image:</Text>
                <View style={$buttonGrid}>
                  {[
                    {label: "Pattern", value: "pattern"},
                    {label: "Checkerboard", value: "checkerboard"},
                    {label: "Solid Color", value: "solid"},
                  ].map(image => (
                    <PillButton
                      key={image.value}
                      text={image.label}
                      variant={selectedImageType === image.value ? "primary" : "secondary"}
                      onPress={() => setSelectedImageType(image.value)}
                      buttonStyle={$gridButton}
                    />
                  ))}
                </View>
              </View>

              {/* Pattern Preview and Send Button */}
              <View style={$previewSection}>
                <Text style={themed($label)}>Preview:</Text>
                <View style={$previewContainer}>
                  <PatternPreview
                    imageType={selectedImageType}
                    imageSize={selectedImageSize}
                    isDark={theme.isDark}
                    showDualLayout={true}
                  />
                  <PillButton
                    text="Send Image"
                    variant="primary"
                    onPress={onSendImageClick}
                    disabled={false}
                    buttonStyle={$fullWidthButton}
                  />
                </View>
              </View>
            </View>

            {/* Clear Display */}
            <View style={themed($settingsGroup)}>
              <Text style={themed($sectionTitle)}>Clear Display</Text>
              <Text style={themed($description)}>Clear all content (text or images) from the display</Text>
              <PillButton
                text="Clear Display"
                variant="secondary"
                onPress={onClearDisplayClick}
                disabled={false}
                buttonStyle={$fullWidthButton}
              />
            </View>

            {/* BLE Command Monitor */}
            <View style={themed($settingsGroup)}>
              <Text style={themed($sectionTitle)}>BLE Command Monitor</Text>
              <Text style={themed($description)}>
                Monitor BLE commands sent and received (Interface v{NEX_INTERFACE_VERSION})
              </Text>

              <Text style={themed($label)}>Last Sent Command:</Text>
              {commandSender ? (
                <>
                  <Text style={themed($commandText)}>Command: {commandSender.command}</Text>
                  <View style={$commandRow}>
                    <Text style={[themed($commandText), $flexText]}>
                      HEX:{" "}
                      {showFullSenderCommand || !commandSender.commandText || commandSender.commandText.length <= 50
                        ? commandSender.commandText
                        : commandSender.commandText.substring(0, 50) + "..."}
                    </Text>
                    {commandSender.commandText && commandSender.commandText.length > 50 && (
                      <TouchableOpacity
                        onPress={() => setShowFullSenderCommand(!showFullSenderCommand)}
                        style={$moreButton}>
                        <Text style={themed($moreButtonText)}>{showFullSenderCommand ? "Less" : "More"}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  {commandSender.timestamp && (
                    <Text style={themed($timestampText)}>
                      Time: {new Date(commandSender.timestamp).toLocaleTimeString()}
                    </Text>
                  )}
                </>
              ) : (
                <Text style={themed($noDataText)}>No commands sent yet</Text>
              )}

              <Text style={[themed($label), $topMargin]}>Last Received Command:</Text>
              {commandReceiver ? (
                <>
                  <Text style={themed($commandText)}>Command: {commandReceiver.command}</Text>
                  <View style={$commandRow}>
                    <Text style={[themed($commandText), $flexText]}>
                      HEX:{" "}
                      {showFullReceiverCommand ||
                      !commandReceiver.commandText ||
                      commandReceiver.commandText.length <= 50
                        ? commandReceiver.commandText
                        : commandReceiver.commandText.substring(0, 50) + "..."}
                    </Text>
                    {commandReceiver.commandText && commandReceiver.commandText.length > 50 && (
                      <TouchableOpacity
                        onPress={() => setShowFullReceiverCommand(!showFullReceiverCommand)}
                        style={$moreButton}>
                        <Text style={themed($moreButtonText)}>{showFullReceiverCommand ? "Less" : "More"}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  {commandReceiver.timestamp && (
                    <Text style={themed($timestampText)}>
                      Time: {new Date(commandReceiver.timestamp).toLocaleTimeString()}
                    </Text>
                  )}
                </>
              ) : (
                <Text style={themed($noDataText)}>No commands received yet</Text>
              )}
            </View>

            {/* LC3 Audio Control */}
            <View style={themed($settingsGroup)}>
              <Text style={themed($sectionTitle)}>🔊 LC3 Audio Control</Text>
              <Text style={themed($description)}>Enable or disable LC3 audio playback from glasses</Text>

              <ToggleSetting
                label="LC3 Audio Playback"
                subtitle="Play audio received from glasses through LC3 codec"
                value={lc3AudioEnabled}
                onValueChange={onLc3AudioToggle}
                containerStyle={$toggleContainer}
              />
            </View>

            {/* Ping-Pong Console */}
            <View style={themed($settingsGroup)}>
              <Text style={themed($sectionTitle)}>💓 Ping-Pong Console</Text>
              <Text style={themed($description)}>Monitor ping-pong communication with Mentra Nex glasses</Text>

              <Text style={themed($label)}>🏓 Last Pong Sent:</Text>
              <Text style={themed($timestampText)}>Time: {formatTimestamp(lastHeartbeatSent)}</Text>

              <Text style={[themed($label), $topMargin]}>🏓 Last Ping Received:</Text>
              <Text style={themed($timestampText)}>Time: {formatTimestamp(lastHeartbeatReceived)}</Text>

              <Text style={[themed($label), $topMargin]}>Ping-Pong Health:</Text>
              <Text
                style={[
                  themed($timestampText),
                  {
                    color:
                      lastHeartbeatReceived && Date.now() - lastHeartbeatReceived < 45000
                        ? theme.colors.palette.primary500
                        : theme.colors.error,
                  },
                ]}>
                {lastHeartbeatReceived
                  ? Date.now() - lastHeartbeatReceived < 45000
                    ? "🟢 Active (Receiving Pings)"
                    : "🔴 Ping Timeout"
                  : "⚪ No Pings Received"}
              </Text>
              {lastHeartbeatSent && lastHeartbeatReceived && (
                <Text style={themed($timestampText)}>
                  Response Time: {Math.abs(lastHeartbeatSent - lastHeartbeatReceived)}ms
                </Text>
              )}
            </View>
          </>
        ) : (
          <View style={themed($settingsGroup)}>
            <Text style={themed($sectionTitle)}>Mentra Nex Required</Text>
            <Text style={themed($description)}>
              Connect to Mentra Nex glasses to access BLE testing tools and advanced developer features.
            </Text>
          </View>
        )}

        <View style={$spacer} />
      </View>
    </ScrollView>
  )
}

const $container: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $content: ThemedStyle<ViewStyle> = ({spacing}) => ({
  padding: spacing.s4,
  gap: spacing.s4,
})

const $headerSection: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.background,
  paddingVertical: spacing.s6,
  paddingHorizontal: spacing.s4,
  borderRadius: spacing.s4,
  borderWidth: 2,
  borderColor: colors.border,
  alignItems: "center",
})

const $title: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 24,
  fontWeight: "700",
  textAlign: "center",
  marginBottom: 8,
})

const $subtitle: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textDim,
  fontSize: 16,
  textAlign: "center",
  lineHeight: 22,
})

const $settingsGroup: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.background,
  paddingVertical: spacing.s4,
  paddingHorizontal: spacing.s4,
  borderRadius: spacing.s4,
  borderWidth: 2,
  borderColor: colors.border,
})

const $sectionTitle: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 18,
  fontWeight: "600",
  marginBottom: 8,
})

const $description: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  color: colors.textDim,
  fontSize: 14,
  marginBottom: spacing.s3,
  lineHeight: 20,
})

const $label: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 16,
  fontWeight: "500",
  marginBottom: 8,
})

const $textInput: ThemedStyle<TextStyle> = ({colors}) => ({
  borderWidth: 1,
  borderRadius: 12,
  paddingHorizontal: 12,
  paddingVertical: 10,
  fontSize: 14,
  marginBottom: 12,
  backgroundColor: colors.background,
  borderColor: colors.border,
  color: colors.text,
})

const $inputRow: ViewStyle = {
  flexDirection: "row",
  gap: 10,
}

const $smallInput: TextStyle = {
  flex: 1,
}

const $buttonRow: ViewStyle = {
  flexDirection: "row",
  gap: 12,
  marginTop: 8,
}

const $primaryButton: ViewStyle = {
  flex: 1,
}

const $secondaryButton: ViewStyle = {
  flex: 1,
}

const $selectionSection: ViewStyle = {
  marginBottom: 16,
}

const $buttonGrid: ViewStyle = {
  flexDirection: "row",
  flexWrap: "wrap",
  gap: 8,
}

const $gridButton: ViewStyle = {
  minWidth: 80,
}

const $previewSection: ViewStyle = {
  marginTop: 16,
}

const $previewContainer: ViewStyle = {
  alignItems: "center",
  gap: 16,
}

const $fullWidthButton: ViewStyle = {
  width: "100%",
}

const $commandText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textDim,
  fontSize: 14,
  marginBottom: 4,
})

const $commandRow: ViewStyle = {
  flexDirection: "row",
  alignItems: "flex-start",
  marginBottom: 4,
}

const $flexText: TextStyle = {
  flex: 1,
}

const $moreButton: ViewStyle = {
  marginLeft: 8,
  paddingVertical: 2,
}

const $moreButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.palette.primary500,
  fontSize: 12,
  fontWeight: "500",
})

const $timestampText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textDim,
  fontSize: 12,
  marginBottom: 4,
})

const $noDataText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textDim,
  fontSize: 14,
  fontStyle: "italic",
  marginBottom: 16,
})

const $topMargin: TextStyle = {
  marginTop: 16,
}

const $toggleContainer: ViewStyle = {
  paddingHorizontal: 0,
  paddingTop: 0,
  paddingBottom: 0,
  borderWidth: 0,
}

const $spacer: ViewStyle = {
  height: 30,
}

const $versionContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginTop: spacing.s4,
  alignItems: "center",
  gap: spacing.s2,
})

const $versionBadge: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.palette.primary100,
  color: colors.palette.primary600,
  fontSize: 12,
  fontWeight: "600",
  paddingHorizontal: spacing.s3,
  paddingVertical: spacing.s2,
  borderRadius: spacing.s2,
  borderWidth: 1,
  borderColor: colors.palette.primary300,
  overflow: "hidden",
})

const $protobufVersionBadge: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.palette.neutral100,
  color: colors.palette.neutral600,
  fontSize: 12,
  fontWeight: "600",
  paddingHorizontal: spacing.s3,
  paddingVertical: spacing.s2,
  borderRadius: spacing.s2,
  borderWidth: 1,
  borderColor: colors.palette.neutral300,
  overflow: "hidden",
  fontFamily: "monospace",
})

const $glassesProtobufVersionBadge: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.palette.accent100,
  color: colors.palette.accent500,
  fontSize: 12,
  fontWeight: "600",
  paddingHorizontal: spacing.s3,
  paddingVertical: spacing.s2,
  borderRadius: spacing.s2,
  borderWidth: 1,
  borderColor: colors.palette.accent300,
  overflow: "hidden",
  fontFamily: "monospace",
})
