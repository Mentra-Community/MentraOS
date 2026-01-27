import {Platform} from "react-native"
import {DeviceTypes} from "@/../../cloud/packages/types/src"

export const getGlassesImage = (glasses: string | null) => {
  switch (glasses) {
    case "Vuzix-z100":
    case "Vuzix Z100":
    case "Vuzix Ultralite":
      return require("../../assets/glasses/vuzix_z100.png")
    case "Mentra Mach1":
    case "Mach1":
      return require("../../assets/glasses/vuzix_z100.png")
    case "Mentra Live":
    case "mentra_live":
      return require("../../assets/glasses/mentra_live/mentra_live.png")
    case "inmo_air":
      return require("../../assets/glasses/inmo_air.png")
    case "tcl_rayneo_x_two":
      return require("../../assets/glasses/tcl_rayneo_x_two.png")
    case "Vuzix_shield":
      return require("../../assets/glasses/vuzix_shield.png")
    case "Even Realities G1":
    case "Mentra Nex":
    case "evenrealities_g1":
    case "g1":
      return require("../../assets/glasses/g1.png")
    case "virtual-wearable":
    case "Audio Wearable":
      return require("../../assets/glasses/audio_wearable.png")
    case DeviceTypes.SIMULATED:
      if (Platform.OS === "ios") {
        return require("../../assets/guide/iphone.png")
      } else {
        return require("../../assets/guide/android.png")
      }
    case "Brilliant Labs Frame":
    case "frame":
      return require("../../assets/glasses/frame.png")
    default:
      return require("../../assets/glasses/g1.png")
  }
}

export const getEvenRealitiesG1Image = (
  style?: string,
  color?: string,
  state: string = "wearing",
  side: string = "l",
  dark: boolean = false,
  batteryLevel?: number,
) => {
  // console.log("style", style)
  // console.log("color", color)
  // console.log("state", state)
  // console.log("side", side)
  // console.log("dark", dark)

  // Map style names to file prefixes
  const styleMap: {[key: string]: string} = {
    Round: "a",
    Rectangular: "b",
  }

  // Map color names to file suffixes
  const colorMap: {[key: string]: string} = {
    Grey: "grey1",
    Brown: "brown1",
    Green: "green1",
  }

  // Default to Round style if not specified
  // const stylePrefix = "a"
  const stylePrefix = style ? styleMap[style] || "a" : "a"
  // Default to Grey color if not specified
  // const colorSuffix = "grey1"
  const colorSuffix = color ? colorMap[color] || "grey1" : "grey1"
  // Default to left side if not specified
  const sideSuffix = side || "l"
  // Add dark suffix if dark mode is requested
  const darkSuffix = dark ? "_dark" : ""

  // console.log("state", state)
  // console.log("batteryLevel", batteryLevel)

  // Battery logic for case_open/case_close
  let effectiveState = state
  if (state === "case_open" || state === "case_close") {
    if (typeof batteryLevel === "number") {
      if (state === "case_open") {
        effectiveState = batteryLevel > 50 ? "case_open_full" : "case_open"
      } else if (state === "case_close") {
        effectiveState = batteryLevel > 50 ? "case_close_full" : "case_close"
      }
    } else {
      // Default to full if batteryLevel is not provided
      effectiveState = state === "case_open" ? "case_open_full" : "case_close_full"
    }
  }

  const imageKey = `${stylePrefix}_${colorSuffix}_${sideSuffix}_${effectiveState}${darkSuffix}`

  // console.log("imageKey", imageKey)
  // Static mapping of all possible image combinations (regular + dark)
  const imageMap: {[key: string]: any} = {
    // Round Brown Left - Regular
    a_brown1_l_wearing: require("../../assets/glasses/even_realities/g1/image_g1_a_brown1_l_wearing.png"),
    a_brown1_l_folded: require("../../assets/glasses/even_realities/g1/image_g1_a_brown1_l_folded.png"),
    a_brown1_l_prescription: require("../../assets/glasses/even_realities/g1/image_g1_a_brown1_l_prescription.png"),
    a_brown1_l_case_open: require("../../assets/glasses/even_realities/g1/image_g1_a_brown1_l_case_open_full.png"),
    a_brown1_l_case_close: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_full.png"),
    a_brown1_l_case_charging: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_charging.png"),

    // Round Brown Left - Dark
    a_brown1_l_wearing_dark: require("../../assets/glasses/even_realities/g1/image_g1_a_brown1_l_wearing_dark.png"),
    a_brown1_l_folded_dark: require("../../assets/glasses/even_realities/g1/image_g1_a_brown1_l_folded_dark.png"),
    a_brown1_l_prescription_dark: require("../../assets/glasses/even_realities/g1/image_g1_a_brown1_l_prescription_dark.png"),
    a_brown1_l_case_open_full_dark: require("../../assets/glasses/even_realities/g1/image_g1_a_brown1_l_case_open_full_dark.png"),
    a_brown1_l_case_close_dark: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_full_dark.png"),
    a_brown1_l_case_charging_dark: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_charging_dark.png"),

    // Round Grey Left - Regular
    a_grey1_l_wearing: require("../../assets/glasses/even_realities/g1/image_g1_a_grey1_l_wearing.png"),
    a_grey1_l_folded: require("../../assets/glasses/even_realities/g1/image_g1_a_grey1_l_folded.png"),
    a_grey1_l_prescription: require("../../assets/glasses/even_realities/g1/image_g1_a_grey1_l_prescription.png"),
    a_grey1_l_case_open: require("../../assets/glasses/even_realities/g1/image_g1_a_grey1_l_case_open_full.png"),
    // a_grey1_l_case_open_full: require("../../assets/glasses/even_realities/g1/image_g1_l_case_open_full.png"),
    a_grey1_l_case_close: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_full.png"),
    a_grey1_l_case_charging: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_charging.png"),

    // Round Grey Left - Dark
    a_grey1_l_wearing_dark: require("../../assets/glasses/even_realities/g1/image_g1_a_grey1_l_wearing_dark.png"),
    a_grey1_l_folded_dark: require("../../assets/glasses/even_realities/g1/image_g1_a_grey1_l_folded_dark.png"),
    a_grey1_l_prescription_dark: require("../../assets/glasses/even_realities/g1/image_g1_a_grey1_l_prescription_dark.png"),
    a_grey1_l_case_open_full_dark: require("../../assets/glasses/even_realities/g1/image_g1_a_grey1_l_case_open_full_dark.png"),
    a_grey1_l_case_open_dark: require("../../assets/glasses/even_realities/g1/image_g1_a_grey1_l_case_open_full_dark.png"),
    a_grey1_l_case_close_dark: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_full_dark.png"),
    a_grey1_l_case_charging_dark: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_charging_dark.png"),

    // Round Green Left - Regular
    a_green1_l_wearing: require("../../assets/glasses/even_realities/g1/image_g1_a_green1_l_wearing.png"),
    a_green1_l_folded: require("../../assets/glasses/even_realities/g1/image_g1_a_green1_l_folded.png"),
    a_green1_l_prescription: require("../../assets/glasses/even_realities/g1/image_g1_a_green1_l_prescription.png"),
    a_green1_l_case_open: require("../../assets/glasses/even_realities/g1/image_g1_a_green1_l_case_open_full.png"),
    a_green1_l_case_close: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_full.png"),
    a_green1_l_case_charging: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_charging.png"),

    // Round Green Left - Dark
    a_green1_l_wearing_dark: require("../../assets/glasses/even_realities/g1/image_g1_a_green1_l_wearing_dark.png"),
    a_green1_l_folded_dark: require("../../assets/glasses/even_realities/g1/image_g1_a_green1_l_folded_dark.png"),
    a_green1_l_prescription_dark: require("../../assets/glasses/even_realities/g1/image_g1_a_green1_l_prescription_dark.png"),
    a_green1_l_case_open_dark: require("../../assets/glasses/even_realities/g1/image_g1_a_green1_l_case_open_full_dark.png"),
    a_green1_l_case_close_dark: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_full_dark.png"),
    a_green1_l_case_charging_dark: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_charging_dark.png"),
    // Add missing full variants for green1 open/close dark
    a_green1_l_case_open_full_dark: require("../../assets/glasses/even_realities/g1/image_g1_a_green1_l_case_open_full_dark.png"),
    a_green1_l_case_close_full_dark: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_full_dark.png"),
    // Add missing full variants for green1 open/close regular
    a_green1_l_case_open_full: require("../../assets/glasses/even_realities/g1/image_g1_a_green1_l_case_open_full.png"),
    a_green1_l_case_close_full: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_full.png"),
    // Add missing charging variants for green1 open/close dark
    a_green1_l_case_open_charging_dark: require("../../assets/glasses/even_realities/g1/image_g1_a_green1_l_case_open_charging_dark.png"),
    a_green1_l_case_close_charging_dark: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_charging_dark.png"),
    // Add missing charging variants for green1 open/close regular
    a_green1_l_case_open_charging: require("../../assets/glasses/even_realities/g1/image_g1_a_green1_l_case_open_charging.png"),
    a_green1_l_case_close_charging: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_charging.png"),

    // Rectangular Brown Left - Regular
    b_brown1_l_wearing: require("../../assets/glasses/even_realities/g1/image_g1_b_brown1_l_wearing.png"),
    b_brown1_l_folded: require("../../assets/glasses/even_realities/g1/image_g1_b_brown1_l_folded.png"),
    b_brown1_l_prescription: require("../../assets/glasses/even_realities/g1/image_g1_b_brown1_l_prescription.png"),
    b_brown1_l_case_open: require("../../assets/glasses/even_realities/g1/image_g1_b_brown1_l_case_open_full.png"),
    b_brown1_l_case_close: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_full.png"),
    b_brown1_l_case_charging: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_charging.png"),
    // Add missing full/charging variants for b_brown1_l open regular
    b_brown1_l_case_open_full: require("../../assets/glasses/even_realities/g1/image_g1_b_brown1_l_case_open_full.png"),
    b_brown1_l_case_open_charging: require("../../assets/glasses/even_realities/g1/image_g1_b_brown1_l_case_open_charging.png"),

    // Rectangular Brown Left - Dark
    b_brown1_l_wearing_dark: require("../../assets/glasses/even_realities/g1/image_g1_b_brown1_l_wearing_dark.png"),
    b_brown1_l_folded_dark: require("../../assets/glasses/even_realities/g1/image_g1_b_brown1_l_folded_dark.png"),
    b_brown1_l_prescription_dark: require("../../assets/glasses/even_realities/g1/image_g1_b_brown1_l_prescription_dark.png"),
    b_brown1_l_case_open_dark: require("../../assets/glasses/even_realities/g1/image_g1_b_brown1_l_case_open_full_dark.png"),
    b_brown1_l_case_close_dark: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_full_dark.png"),
    b_brown1_l_case_charging_dark: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_charging_dark.png"),
    // Add missing full/charging variants for b_brown1_l open dark
    b_brown1_l_case_open_full_dark: require("../../assets/glasses/even_realities/g1/image_g1_b_brown1_l_case_open_full_dark.png"),
    b_brown1_l_case_open_charging_dark: require("../../assets/glasses/even_realities/g1/image_g1_b_brown1_l_case_open_charging_dark.png"),

    // Rectangular Grey Left - Regular
    b_grey1_l_wearing: require("../../assets/glasses/even_realities/g1/image_g1_b_grey1_l_wearing.png"),
    b_grey1_l_folded: require("../../assets/glasses/even_realities/g1/image_g1_b_grey1_l_folded.png"),
    b_grey1_l_prescription: require("../../assets/glasses/even_realities/g1/image_g1_b_grey1_l_prescription.png"),
    b_grey1_l_case_open: require("../../assets/glasses/even_realities/g1/image_g1_b_grey1_l_case_open_full.png"),
    b_grey1_l_case_close: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_full.png"),
    b_grey1_l_case_charging: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_charging.png"),
    // Add missing full/charging variants for b_grey1_l open regular
    b_grey1_l_case_open_full: require("../../assets/glasses/even_realities/g1/image_g1_b_grey1_l_case_open_full.png"),
    b_grey1_l_case_open_charging: require("../../assets/glasses/even_realities/g1/image_g1_b_grey1_l_case_open_charging.png"),

    // Rectangular Grey Left - Dark
    b_grey1_l_wearing_dark: require("../../assets/glasses/even_realities/g1/image_g1_b_grey1_l_wearing_dark.png"),
    b_grey1_l_folded_dark: require("../../assets/glasses/even_realities/g1/image_g1_b_grey1_l_folded_dark.png"),
    b_grey1_l_prescription_dark: require("../../assets/glasses/even_realities/g1/image_g1_b_grey1_l_prescription_dark.png"),
    b_grey1_l_case_open_dark: require("../../assets/glasses/even_realities/g1/image_g1_b_grey1_l_case_open_full_dark.png"),
    b_grey1_l_case_close_dark: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_full_dark.png"),
    b_grey1_l_case_charging_dark: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_charging_dark.png"),
    // Add missing full/charging variants for b_grey1_l open dark
    b_grey1_l_case_open_full_dark: require("../../assets/glasses/even_realities/g1/image_g1_b_grey1_l_case_open_full_dark.png"),
    b_grey1_l_case_open_charging_dark: require("../../assets/glasses/even_realities/g1/image_g1_b_grey1_l_case_open_charging_dark.png"),

    // Generic closed case images (no style/color/side)
    l_case_close_full: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_full.png"),
    l_case_close_full_dark: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_full_dark.png"),
    l_case_close_charging: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_charging.png"),
    l_case_close_charging_dark: require("../../assets/glasses/even_realities/g1/image_g1_l_case_close_charging_dark.png"),
  }

  // For case_close images, ignore style and color, always use generic key
  if (effectiveState === "case_close_full" || effectiveState === "case_close_charging") {
    const genericKey = `l_${effectiveState}${darkSuffix}`
    if (imageMap[genericKey]) {
      return imageMap[genericKey]
    }
  }

  if (imageMap[imageKey]) {
    return imageMap[imageKey]
  } else {
    console.warn(`Image not found: ${imageKey}, falling back to default`)
    return require("../../assets/glasses/g1.png")
  }
}

export const getGlassesClosedImage = (glasses: string | null) => {
  switch (glasses) {
    case "g1":
    case "evenrealities_g1":
    case "Even Realities G1":
      return require("../../assets/guide/image_g1_case_closed.png")
    default:
      return getGlassesImage(glasses)
  }
}

export const getGlassesOpenImage = (glasses: string | null) => {
  switch (glasses) {
    case "g1":
    case "evenrealities_g1":
    case "Even Realities G1":
      return require("../../assets/guide/image_g1_pair.png")
    default:
      return getGlassesImage(glasses)
  }
}
