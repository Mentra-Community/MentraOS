import bzip2 from "bzip2"
import RNFS from "react-native-fs"
import Tar from "tar-js"

export class TarBz2Extractor {
  static async extract(
    sourcePath: string,
    destinationPath: string,
    onProgress?: (message: string) => void,
  ): Promise<void> {
    try {
      onProgress?.("Reading compressed file...")

      // Read the .tar.bz2 file as base64
      const base64Data = await RNFS.readFile(sourcePath, "base64")

      // Convert base64 to Uint8Array
      const binaryString = atob(base64Data)
      const bytes = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i)
      }

      onProgress?.(`Decompressing ${bytes.length} bytes...`)

      // Decompress bz2 using the bzip2 library
      let decompressedString: string
      try {
        console.log("Creating bzip2 array...")
        const bz2Array = bzip2.array(bytes)
        console.log("Starting decompression with bzip2.simple()...")

        // Add a progress indicator for long operations
        const startTime = Date.now()
        const progressInterval = setInterval(() => {
          const elapsed = Math.round((Date.now() - startTime) / 1000)
          console.log(`Still decompressing... ${elapsed} seconds elapsed`)
        }, 5000) // Log every 5 seconds

        decompressedString = bzip2.simple(bz2Array)

        clearInterval(progressInterval)
        const totalTime = Math.round((Date.now() - startTime) / 1000)
        console.log(`Decompression complete in ${totalTime} seconds, got ${decompressedString.length} characters`)
      } catch (bz2Error) {
        console.error("Bzip2 decompression error:", bz2Error)
        throw new Error(`Bzip2 decompression failed: ${bz2Error.message || bz2Error}`)
      }

      // Convert decompressed string back to Uint8Array
      console.log("Converting decompressed string to Uint8Array...")
      const decompressed = new Uint8Array(decompressedString.length)
      for (let i = 0; i < decompressedString.length; i++) {
        decompressed[i] = decompressedString.charCodeAt(i)
      }

      onProgress?.(`Decompressed to ${decompressed.length} bytes, extracting tar...`)

      // Extract tar using tar-js
      const tar = new Tar()
      tar.parseTarBuffer(decompressed.buffer)
      const files = tar.getFiles()

      onProgress?.(`Found ${files.length} files in archive`)

      // Create destination directory
      await RNFS.mkdir(destinationPath, {NSURLIsExcludedFromBackupKey: true})

      // Process and write files
      for (const file of files) {
        // Skip directories (tar-js doesn't have directories in the list)
        if (!file || !file.name) continue

        let fileName = file.name

        // Remove leading ./ if present
        if (fileName.startsWith("./")) {
          fileName = fileName.substring(2)
        }

        // Strip first directory component (like --strip-components=1)
        const firstSlashIndex = fileName.indexOf("/")
        if (firstSlashIndex !== -1) {
          fileName = fileName.substring(firstSlashIndex + 1)
        }

        // Skip if no filename remains or if it's a directory
        if (!fileName || fileName.endsWith("/")) continue

        // Handle file renaming for model files
        if (fileName === "encoder-epoch-99-avg-1.onnx") {
          fileName = "encoder.onnx"
        } else if (fileName === "decoder-epoch-99-avg-1.onnx") {
          fileName = "decoder.onnx"
        } else if (fileName === "joiner-epoch-99-avg-1.int8.onnx") {
          fileName = "joiner.onnx"
        }

        const filePath = `${destinationPath}/${fileName}`

        // Create parent directories if needed
        const parentDir = filePath.substring(0, filePath.lastIndexOf("/"))
        if (parentDir && parentDir !== destinationPath) {
          await RNFS.mkdir(parentDir, {NSURLIsExcludedFromBackupKey: true})
        }

        // tar-js gives us the data as a string, convert to base64
        const fileContent = file.data
        const base64FileData = btoa(fileContent)

        await RNFS.writeFile(filePath, base64FileData, "base64")

        onProgress?.(`Extracted ${fileName}`)
      }

      onProgress?.("Extraction complete!")

      // Check if files were extracted into a nested directory (for archives with ./ prefix)
      const nestedDirPath = `${destinationPath}/${destinationPath.split("/").pop()}`
      const nestedDirExists = await RNFS.exists(nestedDirPath)

      if (nestedDirExists) {
        onProgress?.("Moving files from nested directory...")
        const nestedFiles = await RNFS.readDir(nestedDirPath)

        for (const file of nestedFiles) {
          const destFile = `${destinationPath}/${file.name}`
          await RNFS.moveFile(file.path, destFile)
        }

        // Remove the now-empty nested directory
        await RNFS.unlink(nestedDirPath)
      }
    } catch (error) {
      console.error("TarBz2Extractor error:", error)
      throw new Error(`Extraction failed: ${error.message || error}`)
    }
  }
}
