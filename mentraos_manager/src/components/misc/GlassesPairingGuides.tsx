// GlassesPairingGuides.tsx

import {useAppTheme} from "@/utils/useAppTheme"
import React from "react"
import {View, StyleSheet, Image, TouchableOpacity, Linking} from "react-native"
import FontAwesome from "react-native-vector-icons/FontAwesome"
import {Button, Text} from "@/components/ignite"
import {translate} from "@/i18n"
import {showAlert} from "@/utils/AlertUtils"
import {Spacer} from "./Spacer"
import {GlassesFeatureList} from "@/components/glasses/GlassesFeatureList"

// 2) Declare each guide component with the correct prop type
export function EvenRealitiesG1PairingGuide() {
  const {theme} = useAppTheme()
  const textColor = theme.isDark ? "white" : "black"

  return (
    <View style={styles.guideContainer}>
      <Text text="Even Realities G1" style={[styles.guideTitle, {color: textColor}]} />
      <Text
        text="1. Disconnect your G1 from within the Even Realities app, or uninstall the Even Realities app"
        style={[styles.guideStep, {color: textColor}]}
      />
      <Text
        text="2. Place your G1 in the charging case with the lid open."
        style={[styles.guideStep, {color: textColor}]}
      />

      <Image
        source={require("../../../assets/glasses/g1.png")}
        style={{...styles.guideImage, width: "60%", alignSelf: "center"}}
      />

      <FontAwesome name="arrow-down" size={36} color={textColor} style={{alignSelf: "center", marginTop: -36}} />

      <Image source={require("../../../assets/guide/image_g1_pair.png")} style={styles.guideImage} />
    </View>
  )
}

export function VuzixZ100PairingGuide() {
  const {theme} = useAppTheme()
  const textColor = theme.isDark ? "white" : "black"

  return (
    <View style={styles.guideContainer}>
      <Text text="Vuzix Z100" style={[styles.guideTitle, {color: textColor}]} />
      <Text
        text="1. Make sure your Z100 is fully charged and turned on."
        style={[styles.guideStep, {color: textColor}]}
      />
      <Text
        text="2. Pair your Z100 with your device using the Vuzix Connect app."
        style={[styles.guideStep, {color: textColor}]}
      />
    </View>
  )
}

export function MentraMach1PairingGuide() {
  const {theme} = useAppTheme()
  const textColor = theme.isDark ? "white" : "black"

  return (
    <View style={styles.guideContainer}>
      <Text text="Mentra Mach1" style={[styles.guideTitle, {color: textColor}]} />
      <Text
        text="1. Make sure your Mach1 is fully charged and turned on."
        style={[styles.guideStep, {color: textColor}]}
      />
      <Text
        text="2. Pair your Mach1 with your device using the Vuzix Connect app."
        style={[styles.guideStep, {color: textColor}]}
      />
    </View>
  )
}

export function MentraLivePairingGuide() {
  const {theme} = useAppTheme()

  return (
    <View style={styles.guideContainer}>
      <View style={{justifyContent: "flex-start", flexDirection: "column"}}>
        {/* <ScrollView style={{}} nestedScrollEnabled={true}> */}
        <Text text="Mentra Live Beta" style={[styles.guideTitle, {color: theme.colors.text}]} />

        {/* <Text style={[styles.guideStep, {color: theme.colors.text}]}>
        1. Make sure your Mentra Live is fully charged and turned on.
        </Text>
        <Text style={[styles.guideStep, {color: theme.colors.text}]}>
        2. Make sure your Mentra Live is not already paired to a different device.
        </Text> */}

        {/* Product image would go here */}
        <Image
          source={require("../../../assets/glasses/mentra_live.png")}
          style={[styles.guideImage, {marginVertical: 0}]}
          // Fallback if image doesn't exist
          onError={e => console.log("Image failed to load")}
        />

        {/* Feature list */}
        <GlassesFeatureList glassesModel="Mentra Live" />

        {/* Marketing description */}
        <Text
          text="Mentra Live brings the power of computer vision to your everyday life. With a camera that sees what you see, you can build and run AI apps that recognize objects, translate text, remember faces, and more. Perfect for developers creating the next generation of augmented reality experiences."
          style={[styles.guideDescription, {color: theme.colors.text}]}
        />
        {/* </ScrollView> */}

        <View style={styles.buySection}>
          <TouchableOpacity
            style={[styles.preorderButton, {backgroundColor: theme.colors.tint}]}
            onPress={() => {
              // Linking.openURL("https://mentra.glass/live")
              showAlert("Open External Website", "This will open mentra.glass in your web browser. Continue?", [
                {
                  text: "Cancel",
                  style: "cancel",
                },
                {
                  text: "Continue",
                  onPress: () => Linking.openURL("https://mentra.glass/live"),
                },
              ])
            }}>
            <Text
              text={`${translate("pairing:preorderNow")} · $219`}
              style={[styles.buyButtonText, {color: theme.colors.background}]}
            />
            <Text
              tx="pairing:preorderNowShipMessage"
              style={[styles.shippingText, {color: theme.colors.background, opacity: 0.8}]}
            />
          </TouchableOpacity>
          <Spacer height={theme.spacing.md} />
        </View>
      </View>
    </View>
  )
}

export function AudioWearablePairingGuide() {
  const {theme} = useAppTheme()
  const textColor = theme.isDark ? "white" : "black"

  return (
    <View style={styles.guideContainer}>
      <Text text="Audio Wearable" style={[styles.guideTitle, {color: textColor}]} />
      <Text
        text="1. Make sure your Audio Wearable is fully charged and turned on."
        style={[styles.guideStep, {color: textColor}]}
      />
      <Text
        text="2. Enable Bluetooth pairing mode on your Audio Wearable."
        style={[styles.guideStep, {color: textColor}]}
      />
      <Text
        text="3. Note: Audio Wearables don't have displays. All visual information will be converted to speech."
        style={[styles.guideStep, {color: textColor}]}
      />
      <Text
        text="Audio Wearables are smart glasses without displays. They use text-to-speech to provide information that would normally be shown visually. This makes them ideal for audio-only applications or for users who prefer auditory feedback."
        style={[styles.guideDescription, {color: textColor}]}
      />
    </View>
  )
}

export function VirtualWearablePairingGuide() {
  const {theme} = useAppTheme()
  return (
    <View style={styles.guideContainer}>
      <Text text="Simulated Glasses" style={[styles.guideTitle, {color: theme.colors.text}]} />
      <Text
        text="The Simulated Glasses allows you to run MentraOS without physical smart glasses."
        style={[styles.guideStep, {color: theme.colors.text}]}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  // guideContainer: {
  //   marginTop: 20,
  //   width: '90%',
  // },
  // guideTitle: {
  //   fontSize: 18,
  //   fontWeight: 'bold',
  //   marginBottom: 10,
  // },
  // guideStep: {
  //   fontSize: 16,
  //   marginBottom: 8,
  // },
  // guideDescription: {
  //   fontSize: 14,
  //   marginTop: 12,
  //   marginBottom: 8,
  //   fontStyle: 'italic',
  // },
  // guideImage: {
  //   width: '100%',
  //   height: 200, // Adjust height as needed
  //   resizeMode: 'contain',
  //   marginVertical: 10,
  // },

  guideContainer: {
    marginTop: 20,
    width: "90%",
  },
  guideTitle: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 10,
  },
  marketingBanner: {
    borderRadius: 8,
    marginBottom: 15,
    padding: 12,
  },
  marketingTag: {
    fontSize: 12,
    fontWeight: "bold",
    marginBottom: 5,
  },
  marketingText: {
    fontSize: 16,
    fontWeight: "500",
  },
  guideStep: {
    fontSize: 16,
    marginBottom: 8,
  },
  guideDescription: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 20,
    marginTop: 20,
  },
  guideImage: {
    height: 180,
    marginVertical: 15,
    resizeMode: "contain",
    width: "100%",
  },
  featuresContainer: {
    alignItems: "center",
    borderRadius: 16,
    flexDirection: "column",
    padding: 12,
    paddingLeft: 36,
  },
  featuresRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  featureItem: {
    alignItems: "center",
    alignSelf: "center",
    flexDirection: "row",
    flex: 1,
    marginBottom: 12,
  },
  featureText: {
    fontSize: 14,
    fontWeight: "500",
    marginLeft: 10,
  },
  buySection: {
    marginTop: 20,
  },
  preorderButton: {
    alignItems: "center",
    borderRadius: 30,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 12,
    width: "100%",
  },
  buyButtonText: {
    fontSize: 16,
    fontWeight: "bold",
  },
  shippingText: {
    fontSize: 12,
    marginTop: 4,
  },
})
