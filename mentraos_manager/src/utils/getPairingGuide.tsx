import React from "react"
import {View} from "react-native"
import {
  AudioWearablePairingGuide,
  EvenRealitiesG1PairingGuide,
  MentraLivePairingGuide,
  MentraMach1PairingGuide,
  VirtualWearablePairingGuide,
  VuzixZ100PairingGuide,
} from "@/components/misc/GlassesPairingGuides"
import {useAppTheme} from "./useAppTheme"

/**
 * Returns the appropriate pairing guide component based on the glasses model name
 * @param glassesModelName The name of the glasses model
 * @returns The corresponding pairing guide component
 */
export const getPairingGuide = (glassesModelName: string) => {
  switch (glassesModelName) {
    case "Even Realities G1":
      return <EvenRealitiesG1PairingGuide />
    case "Vuzix Z100":
      return <VuzixZ100PairingGuide />
    case "Mentra Live":
      return <MentraLivePairingGuide />
    case "Mentra Mach1":
      return <MentraMach1PairingGuide />
    case "Audio Wearable":
      return <AudioWearablePairingGuide />
    case "Simulated Glasses":
      return <VirtualWearablePairingGuide />
    default:
      return <View />
  }
}
