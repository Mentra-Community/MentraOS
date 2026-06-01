import {type PhotoCompression, type PhotoSize, type RgbLedAction, type RgbLedColor} from "@mentra/bluetooth-sdk"

const PHOTO_SIZES = new Set<PhotoSize>(["small", "medium", "large", "full"])
const PHOTO_COMPRESSIONS = new Set<PhotoCompression>(["none", "medium", "heavy"])
const RGB_LED_ACTIONS = new Set<RgbLedAction>(["on", "off"])
const RGB_LED_COLORS = new Set<RgbLedColor>(["red", "green", "blue", "orange", "white"])

export function normalizePhotoSize(value: unknown): PhotoSize {
  return typeof value === "string" && PHOTO_SIZES.has(value as PhotoSize) ? (value as PhotoSize) : "medium"
}

export function normalizePhotoCompression(value: unknown): PhotoCompression {
  return typeof value === "string" && PHOTO_COMPRESSIONS.has(value as PhotoCompression)
    ? (value as PhotoCompression)
    : "none"
}

export function normalizeRgbLedAction(value: unknown): RgbLedAction {
  return typeof value === "string" && RGB_LED_ACTIONS.has(value as RgbLedAction) ? (value as RgbLedAction) : "off"
}

export function normalizeRgbLedColor(value: unknown): RgbLedColor | null {
  return typeof value === "string" && RGB_LED_COLORS.has(value as RgbLedColor) ? (value as RgbLedColor) : null
}
