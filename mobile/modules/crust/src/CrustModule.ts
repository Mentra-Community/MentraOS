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
  startNavigation(
    lat: number,
    lng: number,
    options?: {
      simulate?: boolean
      speedMultiplier?: number
      /** Optional multi-stop list. When present takes precedence over lat/lng. Last entry is the final destination. */
      stops?: Array<{lat: number; lng: number}>
      /** "walking" | "driving" | "cycling" | "two_wheeler". Defaults driving. */
      mode?: string
      avoid?: {highways?: boolean; tolls?: boolean; ferries?: boolean}
    },
  ): Promise<{ok: boolean; error?: string}>
  stopNavigation(): Promise<{ok: boolean; error?: string}>

  /**
   * Show the Google Nav SDK Terms & Conditions dialog if not already
   * accepted. Idempotent — resolves immediately with `{accepted: true}`
   * when the user has already accepted (cached in-process / on-disk /
   * inside the SDK).
   */
  requestNavigationPermission(): Promise<{ok: boolean; accepted: boolean; error?: string}>

  /**
   * Dev-only: nudge the simulated user position ~offsetMeters perpendicular
   * to the route so the Nav SDK reroutes. Default 20m. Android only.
   */
  simulateDeviation(offsetMeters?: number): Promise<{ok: boolean; error?: string}>

  // Heading / compass (Android only)
  startHeading(): Promise<{ok: boolean; error?: string}>
  stopHeading(): Promise<{ok: boolean; error?: string}>
}

// This call loads the native module object from the JSI.
export default requireNativeModule<CrustModule>("Crust")
