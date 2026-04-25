import {NativeModule, requireNativeModule} from "expo"

import {CrustModuleEvents} from "./Crust.types"

declare class CrustModule extends NativeModule<CrustModuleEvents> {
  PI: number
  hello(): string
  setValueAsync(value: string): Promise<void>

  // Image Processing Commands
  processGalleryImage(
    inputPath: string,
    outputPath: string,
    options: {
      lensCorrection?: boolean
      colorCorrection?: boolean
    },
  ): Promise<{
    success: boolean
    outputPath?: string
    processingTimeMs?: number
    error?: string
  }>

  mergeHdrBrackets(
    underPath: string,
    normalPath: string,
    overPath: string,
    outputPath: string,
  ): Promise<{
    success: boolean
    outputPath?: string
    processingTimeMs?: number
    error?: string
  }>

  stabilizeVideo(
    inputPath: string,
    imuPath: string,
    outputPath: string,
  ): Promise<{
    success: boolean
    outputPath?: string
    processingTimeMs?: number
    error?: string
  }>

  // Media Library Commands
  saveToGalleryWithDate(
    filePath: string,
    captureTimeMillis?: number,
  ): Promise<{
    success: boolean
    uri?: string
    identifier?: string
    error?: string
  }>

  // Navigation (Android only — iOS stubs return error)
  startNavigation(lat: number, lng: number): Promise<{ok: boolean; error?: string}>
  stopNavigation(): Promise<{ok: boolean; error?: string}>

  // Heading / compass (Android only)
  startHeading(): Promise<{ok: boolean; error?: string}>
  stopHeading(): Promise<{ok: boolean; error?: string}>
}

// This call loads the native module object from the JSI.
export default requireNativeModule<CrustModule>("Crust")
