import {Platform} from "react-native"
import {check, request, PERMISSIONS, RESULTS} from "react-native-permissions"
import * as ExpoMediaLibrary from "expo-media-library"

import CrustModule from "crust"
import type {DownloadedFile} from "@/services/asg/localStorageService"

export interface SaveToLibraryResult {
  success: boolean
  assetId?: string
  assetUri?: string
  error?: string
}

interface AndroidGalleryAssetState {
  exists: boolean
  trashed?: boolean
  identifier?: string
}

export interface DeleteFromLibraryResult {
  deleted: number
  failed: number
  skipped: number
}

/**
 * MediaLibraryPermissions - Handles save-only permissions for camera roll
 *
 * Platform behavior:
 * - iOS: Uses PHOTO_LIBRARY (read/write) so we can reconcile deletes from the system gallery
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
        const status = await check(PERMISSIONS.IOS.PHOTO_LIBRARY)
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
        const status = await request(PERMISSIONS.IOS.PHOTO_LIBRARY)
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
   *
   * IMPORTANT: This method sets the DATE_TAKEN (Android) or creation date (iOS)
   * metadata to the original capture time, so gallery apps show the correct date.
   * Also saves files in chronological order for proper "date added" ordering.
   *
   * @param filePath - Path to the file to save
   * @param creationTime - Optional creation/capture time in milliseconds (Unix timestamp)
   */
  static async saveToLibrary(filePath: string, creationTime?: number): Promise<SaveToLibraryResult> {
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
            return {success: false, error: "Permission denied"}
          }
        }
      }

      // Remove file:// prefix if present
      const cleanPath = filePath.replace("file://", "")

      // Use native module to save with proper DATE_TAKEN / creation date metadata
      // This ensures gallery apps show the correct capture date, not the sync date
      const result = await CrustModule.saveToGalleryWithDate(cleanPath, creationTime)

      if (result.success) {
        const assetId =
          typeof result.identifier === "string" && result.identifier.length > 0 ? result.identifier : undefined
        const assetUri = typeof result.uri === "string" && result.uri.length > 0 ? result.uri : undefined

        if (creationTime) {
          const captureDate = new Date(creationTime)
          console.log(
            `[MediaLibrary] Saved to camera roll with DATE_TAKEN: ${cleanPath} (captured: ${captureDate.toISOString()})`,
          )
        } else {
          console.log(`[MediaLibrary] Saved to camera roll: ${cleanPath}`)
        }
        return {success: true, assetId, assetUri}
      } else {
        console.error(`[MediaLibrary] Failed to save to library: ${result.error}`)
        return {success: false, error: result.error || "Failed to save to library"}
      }
    } catch (error) {
      console.error("[MediaLibrary] Error saving to library:", error)
      return {success: false, error: error instanceof Error ? error.message : "Unknown error"}
    }
  }

  /**
   * Returns local file names whose linked phone-gallery assets no longer exist.
   * Used to mirror user deletes from the system gallery into Mentra local storage.
   */
  static async getMissingLinkedFileNames(files: Record<string, DownloadedFile>): Promise<string[]> {
    const fileEntries = Object.entries(files)
    if (fileEntries.length === 0) return []

    const canReadLibrary = await this.checkPermission()
    if (!canReadLibrary) {
      // No read permission means we cannot safely reconcile; skip without deleting anything.
      console.log("[MediaLibrary] Skipping mirror-delete reconciliation: no photo library read access")
      return []
    }

    const missing: string[] = []
    for (const [fileName, file] of fileEntries) {
      try {
        if (Platform.OS === "android") {
          const displayName = this.getDisplayNameForLookup(file)
          const state = file.libraryAssetId
            ? ((await (CrustModule as any).getGalleryAssetState(
                file.libraryAssetId,
                file.is_video,
              )) as AndroidGalleryAssetState)
            : ((await (CrustModule as any).findGalleryAssetByDisplayName(
                displayName,
                file.is_video,
              )) as AndroidGalleryAssetState)

          // Treat trashed assets as deleted from user's perspective.
          if (!state?.exists || state?.trashed) {
            missing.push(fileName)
          }
          continue
        }

        if (!file.libraryAssetId) {
          // iOS fallback without a stored asset ID is not deterministic; skip.
          continue
        }

        const assetInfo = await ExpoMediaLibrary.getAssetInfoAsync(file.libraryAssetId)
        if (!assetInfo?.id) {
          missing.push(fileName)
        }
      } catch {
        // getAssetInfoAsync throws when asset is missing/invalid.
        missing.push(fileName)
      }
    }

    return missing
  }

  static async deleteFromLibrary(files: DownloadedFile[]): Promise<DeleteFromLibraryResult> {
    if (files.length === 0) {
      return {deleted: 0, failed: 0, skipped: 0}
    }

    if (Platform.OS === "android") {
      let deleted = 0
      let failed = 0
      let skipped = 0

      for (const file of files) {
        try {
          let assetId = file.libraryAssetId
          if (!assetId) {
            const lookup = (await (CrustModule as any).findGalleryAssetByDisplayName(
              this.getDisplayNameForLookup(file),
              file.is_video,
            )) as AndroidGalleryAssetState

            if (lookup?.exists && lookup?.identifier) {
              assetId = lookup.identifier
            } else {
              skipped++
              continue
            }
          }

          const result = (await (CrustModule as any).deleteGalleryAsset(assetId, file.is_video)) as {
            success: boolean
          }
          if (result?.success) {
            deleted++
          } else {
            failed++
          }
        } catch {
          failed++
        }
      }

      return {deleted, failed, skipped}
    }

    if (Platform.OS === "ios") {
      const assetIds = files.map((file) => file.libraryAssetId).filter((id): id is string => !!id)
      const skipped = files.length - assetIds.length

      if (assetIds.length === 0) {
        return {deleted: 0, failed: 0, skipped}
      }

      try {
        const success = await ExpoMediaLibrary.deleteAssetsAsync(assetIds)
        if (success) {
          return {deleted: assetIds.length, failed: 0, skipped}
        }
        return {deleted: 0, failed: assetIds.length, skipped}
      } catch {
        return {deleted: 0, failed: assetIds.length, skipped}
      }
    }

    return {deleted: 0, failed: 0, skipped: files.length}
  }

  private static getDisplayNameForLookup(file: DownloadedFile): string {
    const normalizedPath = file.filePath.replace("file://", "")
    const lastSlash = normalizedPath.lastIndexOf("/")
    if (lastSlash >= 0 && lastSlash < normalizedPath.length - 1) {
      return normalizedPath.substring(lastSlash + 1)
    }
    return file.name
  }
}
