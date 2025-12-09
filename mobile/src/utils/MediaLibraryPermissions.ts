import * as MediaLibrary from "expo-media-library"
import {Platform} from "react-native"
import {check, request, PERMISSIONS, RESULTS} from "react-native-permissions"

/**
 * MediaLibraryPermissions - Handles save-only permissions for camera roll
 *
 * Platform behavior:
 * - iOS: Uses PHOTO_LIBRARY_ADD_ONLY (no "select photos" prompt, just save access)
 * - Android 10+ (API 29+): No permission needed to save your own files to MediaStore
 * - Android 9-: Uses WRITE_EXTERNAL_STORAGE (legacy)
 */
export class MediaLibraryPermissions {
  /**
   * Check if we have permission to save to the camera roll
   * Note: On Android 10+, this always returns true since no permission is needed
   */
  static async checkPermission(): Promise<boolean> {
    try {
      if (Platform.OS === "ios") {
        const status = await check(PERMISSIONS.IOS.PHOTO_LIBRARY_ADD_ONLY)
        return status === RESULTS.GRANTED || status === RESULTS.LIMITED
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
   * Request permission to save to the camera roll
   * Note: On Android 10+, this always returns true since no permission is needed
   */
  static async requestPermission(): Promise<boolean> {
    try {
      if (Platform.OS === "ios") {
        const status = await request(PERMISSIONS.IOS.PHOTO_LIBRARY_ADD_ONLY)
        return status === RESULTS.GRANTED || status === RESULTS.LIMITED
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
   * Save a file to the device's camera roll/photo library
   * On Android 10+, this works without any permission
   */
  static async saveToLibrary(filePath: string): Promise<boolean> {
    try {
      // On Android 10+, we can save without permission
      // On iOS and older Android, check permission first
      if (!(Platform.OS === "android" && Platform.Version >= 29)) {
        const hasPermission = await this.checkPermission()
        if (!hasPermission) {
          console.warn("[MediaLibrary] No permission to save to library")
          return false
        }
      }

      // Remove file:// prefix if present
      const cleanPath = filePath.replace("file://", "")

      await MediaLibrary.createAssetAsync(cleanPath)
      console.log(`[MediaLibrary] Saved to camera roll: ${cleanPath}`)
      return true
    } catch (error) {
      console.error("[MediaLibrary] Error saving to library:", error)
      return false
    }
  }
}
