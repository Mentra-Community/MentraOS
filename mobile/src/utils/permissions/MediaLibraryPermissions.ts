import {Platform} from "react-native"
import {check, request, PERMISSIONS, RESULTS} from "react-native-permissions"

import CrustModule from "@mentra/crust"

import {deriveGalleryDisplayName} from "./galleryDisplayName"

/**
 * MediaLibraryPermissions - Handles save-only permissions for camera roll
 *
 * Platform behavior:
 * - iOS: Prefers PHOTO_LIBRARY_ADD_ONLY (iOS 14+ "Add Photos Only") which is sufficient
 *   for saving. Falls back to checking full PHOTO_LIBRARY (GRANTED or LIMITED).
 * - Android 10+ (API 29+): No permission needed to save your own files to MediaStore
 * - Android 9-: Uses WRITE_EXTERNAL_STORAGE (legacy)
 */
export class MediaLibraryPermissions {
  /**
   * Check if we have permission to save to the camera roll.
   * On iOS 14+, "Add Photos Only" (PHOTO_LIBRARY_ADD_ONLY) is sufficient and is
   * checked alongside the full PHOTO_LIBRARY permission.
   * On Android 10+, this always returns true since no permission is needed.
   */
  static async checkPermission(): Promise<boolean> {
    try {
      if (Platform.OS === "ios") {
        const status = await check(PERMISSIONS.IOS.PHOTO_LIBRARY)
        if (status === RESULTS.GRANTED || status === RESULTS.LIMITED) return true
        // iOS 14+: user may have chosen "Add Photos Only" — sufficient for saving
        const addOnlyStatus = await check(PERMISSIONS.IOS.PHOTO_LIBRARY_ADD_ONLY)
        return addOnlyStatus === RESULTS.GRANTED
      }

      if (Platform.OS === "android") {
        // Android 10+ (API 29+): No permission needed to save your own files
        if (Platform.Version >= 29) {
          return true
        }
        // Android 9 and below: Check legacy write permission
        const status = await check(PERMISSIONS.ANDROID.WRITE_EXTERNAL_STORAGE)
        return status === RESULTS.GRANTED
      }

      return false
    } catch (error) {
      console.error("[MediaLibrary] Error checking permission:", error)
      // On error, assume we can try (Android 10+ doesn't need permission anyway)
      return Platform.OS === "android" && Platform.Version >= 29
    }
  }

  /**
   * Request permission to save to the camera roll.
   * On iOS 14+, requests PHOTO_LIBRARY_ADD_ONLY first (least-privilege ask per Apple
   * guidelines). Falls back to checking full PHOTO_LIBRARY if already granted.
   * On Android 10+, this always returns true since no permission is needed.
   */
  static async requestPermission(): Promise<boolean> {
    try {
      if (Platform.OS === "ios") {
        // First check if full library access is already granted
        const currentStatus = await check(PERMISSIONS.IOS.PHOTO_LIBRARY)
        if (currentStatus === RESULTS.GRANTED || currentStatus === RESULTS.LIMITED) return true

        // iOS 14+: request add-only (least privilege for save-only use case)
        const addOnlyStatus = await request(PERMISSIONS.IOS.PHOTO_LIBRARY_ADD_ONLY)
        if (addOnlyStatus === RESULTS.GRANTED) return true

        // Fall back: request full library if add-only was not granted
        const fullStatus = await request(PERMISSIONS.IOS.PHOTO_LIBRARY)
        return fullStatus === RESULTS.GRANTED || fullStatus === RESULTS.LIMITED
      }

      if (Platform.OS === "android") {
        // Android 10+ (API 29+): No permission needed to save your own files
        if (Platform.Version >= 29) {
          return true
        }
        // Android 9 and below: Request legacy write permission
        const status = await request(PERMISSIONS.ANDROID.WRITE_EXTERNAL_STORAGE)
        return status === RESULTS.GRANTED
      }

      return false
    } catch (error) {
      console.error("[MediaLibrary] Error requesting permission:", error)
      // On error, assume we can try (Android 10+ doesn't need permission anyway)
      return Platform.OS === "android" && Platform.Version >= 29
    }
  }

  /**
   * Save a file to the photo library in a glasses-specific location (MentraOS album on iOS;
   * Pictures/MentraOS or Movies/MentraOS on Android 10+).
   * On Android 10+, this works without any permission.
   *
   * IMPORTANT: This method sets the DATE_TAKEN (Android) or creation date (iOS)
   * metadata to the original capture time, so gallery apps show the correct date.
   * Also saves files in chronological order for proper "date added" ordering.
   *
   * @param filePath - Path to the file to save
   * @param creationTime - Optional creation/capture time in milliseconds (Unix timestamp)
   */
  static async saveToLibrary(filePath: string, creationTime?: number): Promise<boolean> {
    try {
      // On Android 10+, we can save without permission
      // On iOS and older Android, check permission first
      if (!(Platform.OS === "android" && Platform.Version >= 29)) {
        const hasPermission = await this.checkPermission()
        if (!hasPermission) {
          // Try requesting permission one more time
          const granted = await this.requestPermission()
          if (!granted) {
            console.warn("[MediaLibrary] No permission to save to library - photos saved to app storage only")
            return false
          }
        }
      }

      // Remove file:// prefix if present
      const cleanPath = filePath.replace("file://", "")
      const displayName = deriveGalleryDisplayName(cleanPath)

      // Use native module to save with proper DATE_TAKEN / creation date metadata
      // This ensures gallery apps show the correct capture date, not the sync date
      const result = await CrustModule.saveToGalleryWithDate(cleanPath, creationTime, displayName)

      if (result.success) {
        if (creationTime) {
          const captureDate = new Date(creationTime)
          console.log(
            `[MediaLibrary] Saved to camera roll with DATE_TAKEN: ${cleanPath} (captured: ${captureDate.toISOString()})`,
          )
        } else {
          console.log(`[MediaLibrary] Saved to camera roll: ${cleanPath}`)
        }
        return true
      } else {
        console.error(`[MediaLibrary] Failed to save to library: ${result.error}`)
        return false
      }
    } catch (error) {
      console.error("[MediaLibrary] Error saving to library:", error)
      return false
    }
  }
}
