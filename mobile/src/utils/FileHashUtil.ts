/**
 * File Hash Utility
 * Provides SHA256-based file hashing for deduplication
 * Prevents duplicate photos from WiFi Direct + Cloud sync
 */

import CryptoJS from "crypto-js"
import * as RNFS from "@dr.pogodin/react-native-fs"

import {DownloadedFile} from "@/services/asg/localStorageService"

/**
 * Calculate SHA256 hash of a file
 * @param filePath Path to the file
 * @returns SHA256 hash as hex string
 */
export async function calculateFileHash(filePath: string): Promise<string> {
  try {
    // Read file as base64
    const fileData = await RNFS.readFile(filePath, "base64")

    // Calculate SHA256 hash
    const hash = CryptoJS.SHA256(fileData).toString()

    return hash
  } catch (error) {
    console.error("[FileHashUtil] Error calculating hash:", error)
    throw error
  }
}

/**
 * Check if a file is a duplicate based on hash comparison
 * @param newFilePath Path to the new file to check
 * @param existingFiles Array of existing downloaded files
 * @returns true if duplicate found, false otherwise
 */
export async function isDuplicateFile(newFilePath: string, existingFiles: DownloadedFile[]): Promise<boolean> {
  try {
    // Calculate hash of new file
    const newHash = await calculateFileHash(newFilePath)

    // Check against existing files
    for (const existing of existingFiles) {
      if (existing.fileHash && existing.fileHash === newHash) {
        console.log(`[FileHashUtil] Duplicate detected: ${newFilePath} matches ${existing.name}`)
        return true
      }
    }

    return false
  } catch (error) {
    console.error("[FileHashUtil] Error checking duplicate:", error)
    // On error, assume not duplicate (safer to download than skip)
    return false
  }
}

/**
 * Find existing file with matching hash
 * @param hash SHA256 hash to search for
 * @param existingFiles Array of existing downloaded files
 * @returns Matching file or null if not found
 */
export function findFileByHash(hash: string, existingFiles: DownloadedFile[]): DownloadedFile | null {
  for (const file of existingFiles) {
    if (file.fileHash === hash) {
      return file
    }
  }
  return null
}

/**
 * Batch calculate hashes for multiple files
 * @param filePaths Array of file paths
 * @returns Map of filePath -> hash
 */
export async function batchCalculateHashes(filePaths: string[]): Promise<Map<string, string>> {
  const hashMap = new Map<string, string>()

  for (const filePath of filePaths) {
    try {
      const hash = await calculateFileHash(filePath)
      hashMap.set(filePath, hash)
    } catch (error) {
      console.error(`[FileHashUtil] Error hashing ${filePath}:`, error)
      // Continue with other files
    }
  }

  return hashMap
}
