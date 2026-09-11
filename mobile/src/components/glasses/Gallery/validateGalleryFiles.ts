import * as RNFS from "@dr.pogodin/react-native-fs"

export const GALLERY_FILE_VALIDATION_CONCURRENCY = 12

export interface GalleryFileValidationResult<TFile> {
  name: string
  file: TFile
  status: "ok" | "stale" | "unknown"
  shouldUnlink: boolean
}

/**
 * Validate app-local gallery files without flooding the React Native bridge.
 * Large galleries can contain thousands of entries, so an unbounded Promise.all
 * here makes Android schedule every exists/stat operation at once.
 */
export async function validateGalleryFiles<TFile extends {filePath: string}>(
  entries: ReadonlyArray<readonly [string, TFile]>,
  concurrency = GALLERY_FILE_VALIDATION_CONCURRENCY,
): Promise<GalleryFileValidationResult<TFile>[]> {
  if (entries.length === 0) return []

  const results = new Array<GalleryFileValidationResult<TFile>>(entries.length)
  let nextIndex = 0

  const validateNext = async () => {
    while (nextIndex < entries.length) {
      const index = nextIndex++
      const [name, file] = entries[index]
      let status: GalleryFileValidationResult<TFile>["status"] = "unknown"
      let shouldUnlink = false

      try {
        const fileExists = await RNFS.exists(file.filePath)
        if (!fileExists) {
          status = "stale"
        } else {
          try {
            const stat = await RNFS.stat(file.filePath)
            if (stat.size > 0) {
              status = "ok"
            } else {
              console.warn(`[GalleryScreen] Removing zero-byte local file from gallery index: ${name}`)
              status = "stale"
              shouldUnlink = true
            }
          } catch (statError) {
            console.warn(`[GalleryScreen] Could not stat local file ${name}:`, statError)
          }
        }
      } catch (existsError) {
        console.warn(`[GalleryScreen] Could not check existence of local file ${name}:`, existsError)
      }

      results[index] = {name, file, status, shouldUnlink}
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), entries.length)
  await Promise.all(Array.from({length: workerCount}, validateNext))
  return results
}
