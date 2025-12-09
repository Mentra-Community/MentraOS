import {View, ViewStyle, TextStyle, Platform} from "react-native"

import {Button, Icon, Text} from "@/components/ignite"
import Divider from "@/components/ui/Divider"
import {ThemedStyle} from "@/theme"
import {BluetoothSettingsHelper} from "@/utils/BluetoothSettingsHelper"
import {useAppTheme} from "@/utils/useAppTheme"

interface AudioPairingPromptProps {
  deviceName: string
  onSkip?: () => void
}

/**
 * Component that prompts iOS users to pair Mentra Live for audio
 * Shows instructions and a button to open Bluetooth Settings
 */
export function AudioPairingPrompt({deviceName, onSkip}: AudioPairingPromptProps) {
  const {theme, themed} = useAppTheme()

  // Only show on iOS
  if (Platform.OS !== "ios") {
    return null
  }

  const handleOpenSettings = async () => {
    const success = await BluetoothSettingsHelper.openBluetoothSettings()
    if (!success) {
      console.error("Failed to open Bluetooth settings")
    }
  }

  return (
    <View style={themed($container)}>
      <View style={themed($centerWrapper)}>
        <View style={themed($contentContainer)}>
          <Icon name="headphones" size={48} color={theme.colors.text} />

          <Text style={themed($title)} text="Pair Audio" />

          <Text
            style={themed($description)}
            text={`To enable audio, pair "${deviceName}" in your Bluetooth settings.`}
          />

          <View style={themed($instructionsContainer)}>
            <View style={themed($instructionRow)}>
              <Text style={themed($stepNumber)} text="1." />
              <Text style={themed($instructionText)} text="Tap Open Settings below" />
            </View>
            <View style={themed($instructionRow)}>
              <Text style={themed($stepNumber)} text="2." />
              <Text style={themed($instructionText)} text="Go to Bluetooth" />
            </View>
            <View style={themed($instructionRow)}>
              <Text style={themed($stepNumber)} text="3." />
              <Text style={themed($instructionText)} text={`Find "${deviceName}" and tap to pair`} />
            </View>
            <View style={themed($instructionRow)}>
              <Text style={themed($stepNumber)} text="4." />
              <Text style={themed($instructionText)} text="Return to this app" />
            </View>
          </View>

          <Divider />

          <View style={themed($buttonContainer)}>
            {onSkip && <Button preset="alternate" compact text="Skip" onPress={onSkip} style={themed($skipButton)} />}
            <Button preset="default" compact text="Open Settings" onPress={handleOpenSettings} />
          </View>
        </View>
      </View>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  paddingHorizontal: spacing.s4,
})

const $centerWrapper: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  justifyContent: "center",
})

const $contentContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s6,
  borderWidth: 1,
  borderColor: colors.border,
  padding: spacing.s6,
  gap: spacing.s4,
  alignItems: "center",
})

const $title: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 20,
  fontWeight: "600",
  color: colors.text,
  textAlign: "center",
})

const $description: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  color: colors.textDim,
  textAlign: "center",
})

const $instructionsContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  width: "100%",
  paddingHorizontal: spacing.s2,
})

const $instructionRow: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  marginBottom: spacing.s2,
  alignItems: "flex-start",
})

const $stepNumber: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 16,
  fontWeight: "600",
  color: colors.text,
  marginRight: spacing.s2,
  minWidth: 24,
})

const $instructionText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  color: colors.text,
  flexShrink: 1,
})

const $buttonContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  justifyContent: "flex-end",
  width: "100%",
  gap: spacing.s3,
})

const $skipButton: ThemedStyle<ViewStyle> = () => ({
  minWidth: 80,
})
