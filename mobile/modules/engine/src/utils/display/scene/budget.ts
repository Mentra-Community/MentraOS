import {Buffer} from "buffer"

import type {DisplayProfile} from "../profiles/types"
import type {DiffableElement} from "./differ"

/** Reserve native frame capacity in scene order, without decoding app images. */
export function sceneBudget(profile: DisplayProfile): (element: DiffableElement) => boolean {
  const limits = profile.sceneBudget
  if (!limits) return () => true
  let objects = 0
  let textBytes = 0
  let imagePixels = 0
  let encodedBytes = limits.frameOverheadBytes

  return (element) => {
    let nextObjects = 1
    let nextTextBytes = 0
    let nextPixels = 0
    let nextBytes = limits.rectBytes
    if (element.type === "image") {
      nextPixels = element.box.w * element.box.h
      const packed = Math.ceil((nextPixels * limits.image.bitsPerPixel) / 8)
      nextBytes = limits.image.overheadBytes + packed + Math.ceil(packed / limits.image.maxLiteralRunBytes)
    } else if (element.type === "text") {
      const rows = (element.text ?? "")
        .split("\n")
        .filter(
          (row, index) => row.length > 0 && (index === 0 || index * (profile.lineHeightPx ?? Infinity) < element.box.h),
        )
      const border = (element.style?.border ?? 0) > 0 ? 1 : 0
      nextObjects = rows.length + border
      nextTextBytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row, "utf8"), 0)
      nextBytes = nextTextBytes + rows.length * limits.textLineOverheadBytes + border * limits.rectBytes
    }
    if (
      objects + nextObjects > limits.maxObjects ||
      textBytes + nextTextBytes > limits.maxTextBytes ||
      imagePixels + nextPixels > limits.maxImagePixels ||
      encodedBytes + nextBytes > limits.maxEncodedBytes
    )
      return false

    objects += nextObjects
    textBytes += nextTextBytes
    imagePixels += nextPixels
    encodedBytes += nextBytes
    return true
  }
}
