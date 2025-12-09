import {useState, useRef, useEffect} from "react"
import {View, TouchableOpacity, Modal, Image, ImageStyle, Animated} from "react-native"
import MaterialIcons from "react-native-vector-icons/MaterialIcons"

import {Button, Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {getGlassesImage} from "@/utils/getGlassesImage"
import {useAppTheme} from "@/utils/useAppTheme"

interface TroubleshootingModalProps {
  isVisible: boolean
  onClose: () => void
  glassesModelName: string
}

export interface PairingTip {
  title: string
  body: string
  image?: any // Image source (require() or URI)
}

export const getModelSpecificTips = (model: string): PairingTip[] => {
  switch (model) {
    case "Even Realities G1":
      return [
        {
          title: "Fold Left Arm Before Right",
          body: "Make sure you fold the G1's left arm before placing it in the case.",
        },
        {
          title: "Plug In Your Case",
          body: "Plug your G1 case into a charger during the pairing process.",
        },
        {
          title: "Reset the Case",
          body: "Try closing the charging case and opening it again.",
        },
        {
          title: "Check Connected Apps",
          body: "Ensure no other app is currently connected to your G1.",
        },
        {
          title: "Restart Bluetooth",
          body: "Restart your phone's Bluetooth and try pairing again.",
        },
        {
          title: "Stay Close",
          body: "Make sure your phone is within 3 feet of your glasses & case.",
        },
        {
          title: "Unpair Previous Devices",
          body: "If your glasses were previously paired to a different phone, you must unpair/forget the glasses in your phone's Bluetooth settings before retrying the pairing process.",
        },
      ]
    case "Mentra Mach1":
    case "Vuzix Z100":
      return [
        {
          title: "Power On Your Glasses",
          body: "Make sure your glasses are turned on.",
        },
        {
          title: "Check Vuzix Connect",
          body: "Check that your glasses are paired in the 'Vuzix Connect' app.",
        },
        {
          title: "Reset Bluetooth",
          body: "Try resetting your Bluetooth connection.",
        },
      ]
    case "Mentra Live":
      return [
        {
          title: "Charge Your Glasses",
          body: "Make sure your Mentra Live is fully charged.",
        },
        {
          title: "Pairing Mode",
          body: "Check that your Mentra Live is in pairing mode.",
        },
        {
          title: "Check Connected Apps",
          body: "Ensure no other app is currently connected to your glasses.",
        },
        {
          title: "Restart Glasses",
          body: "Try restarting your glasses.",
        },
        {
          title: "Enable Bluetooth",
          body: "Check that your phone's Bluetooth is enabled.",
        },
      ]
    default:
      return [
        {
          title: "Power On",
          body: "Make sure your glasses are charged and turned on.",
        },
        {
          title: "Disconnect Other Devices",
          body: "Ensure no other device is connected to your glasses.",
        },
        {
          title: "Restart Devices",
          body: "Try restarting both your glasses and phone.",
        },
        {
          title: "Stay Within Range",
          body: "Make sure your phone is within range of your glasses.",
        },
      ]
  }
}

const GlassesTroubleshootingModal: React.FC<TroubleshootingModalProps> = ({isVisible, onClose, glassesModelName}) => {
  const {theme, themed} = useAppTheme()
  const tips = getModelSpecificTips(glassesModelName)
  const [currentIndex, setCurrentIndex] = useState(0)
  const fadeAnim = useRef(new Animated.Value(1)).current

  // Reset to first tip when modal opens
  useEffect(() => {
    if (isVisible) {
      setCurrentIndex(0)
      fadeAnim.setValue(1)
    }
  }, [isVisible, fadeAnim])

  const handleNext = () => {
    if (currentIndex < tips.length - 1) {
      Animated.sequence([
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 150,
          useNativeDriver: true,
        }),
      ]).start()
      setCurrentIndex(currentIndex + 1)
    }
  }

  const handleBack = () => {
    if (currentIndex > 0) {
      Animated.sequence([
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 150,
          useNativeDriver: true,
        }),
      ]).start()
      setCurrentIndex(currentIndex - 1)
    }
  }

  const currentTip = tips[currentIndex]
  const fallbackImage = getGlassesImage(glassesModelName)

  return (
    <Modal visible={isVisible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={themed($overlay)}>
        <View style={themed($modalContainer)}>
          {/* Close button */}
          <TouchableOpacity onPress={onClose} style={themed($closeButton)}>
            <MaterialIcons name="close" size={24} color={theme.colors.text} />
          </TouchableOpacity>

          <Animated.View style={{opacity: fadeAnim}}>
            {/* Image */}
            <View style={themed($imageContainer)}>
              <Image source={currentTip.image || fallbackImage} style={themed($image)} resizeMode="contain" />
            </View>

            {/* Title */}
            <Text style={themed($title)} weight="semiBold" text={currentTip.title} />

            {/* Body */}
            <Text style={themed($body)}>{currentTip.body}</Text>
          </Animated.View>

          {/* Pagination dots */}
          <View style={themed($paginationContainer)}>
            {tips.map((_, index) => (
              <View key={index} style={[themed($dot), index === currentIndex && themed($dotActive)]} />
            ))}
          </View>

          {/* Buttons */}
          <View style={themed($buttonContainer)}>
            <Button
              preset="secondary"
              text="Back"
              onPress={handleBack}
              style={themed($backButton)}
              disabled={currentIndex === 0}
            />
            <Button
              preset="primary"
              text={currentIndex === tips.length - 1 ? "Done" : "Next"}
              onPress={currentIndex === tips.length - 1 ? onClose : handleNext}
              style={themed($nextButton)}
            />
          </View>
        </View>
      </View>
    </Modal>
  )
}

const $overlay: ThemedStyle<any> = ({colors}) => ({
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  flex: 1,
  backgroundColor: colors.background + "60",
  justifyContent: "center",
  alignItems: "center",
  paddingHorizontal: 24,
})

const $modalContainer: ThemedStyle<any> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s4,
  borderWidth: 1,
  borderColor: colors.border,
  padding: spacing.s6,
  width: "100%",
  maxWidth: 400,
  elevation: 4,
  shadowColor: "rgba(0, 0, 0, 0.25)",
  shadowOffset: {
    width: 0,
    height: 4,
  },
  shadowOpacity: 1,
  shadowRadius: 4,
})

const $closeButton: ThemedStyle<any> = () => ({
  position: "absolute",
  top: 16,
  right: 16,
  zIndex: 10,
  padding: 4,
})

const $imageContainer: ThemedStyle<any> = ({spacing}) => ({
  alignItems: "center",
  justifyContent: "center",
  marginBottom: spacing.s4,
  minHeight: 200,
})

const $image: ThemedStyle<ImageStyle> = () => ({
  width: "100%",
  height: 200,
  resizeMode: "contain",
})

const $title: ThemedStyle<any> = ({colors, spacing}) => ({
  fontSize: 20,
  color: colors.text,
  textAlign: "center",
  marginBottom: spacing.s3,
})

const $body: ThemedStyle<any> = ({colors, spacing}) => ({
  fontSize: 16,
  color: colors.secondary_foreground,
  textAlign: "center",
  marginBottom: spacing.s6,
  lineHeight: 22,
})

const $paginationContainer: ThemedStyle<any> = ({spacing}) => ({
  flexDirection: "row",
  justifyContent: "center",
  alignItems: "center",
  gap: spacing.s2,
  marginBottom: spacing.s6,
})

const $dot: ThemedStyle<any> = ({colors}) => ({
  width: 8,
  height: 8,
  borderRadius: 4,
  backgroundColor: colors.separator,
})

const $dotActive: ThemedStyle<any> = ({colors}) => ({
  backgroundColor: colors.text,
})

const $buttonContainer: ThemedStyle<any> = ({spacing}) => ({
  flexDirection: "row",
  gap: spacing.s4,
  justifyContent: "center",
})

const $backButton: ThemedStyle<any> = () => ({
  flex: 1,
})

const $nextButton: ThemedStyle<any> = () => ({
  flex: 1,
})

export default GlassesTroubleshootingModal
