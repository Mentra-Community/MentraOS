import BluetoothSdk from "@mentra/bluetooth-sdk"
import * as RNFS from "@dr.pogodin/react-native-fs"

import type {DownloadProgress, ExtractionProgress} from "./STTModelManager"

/**
 * The on-device "Hey Mentra" keyword spotter, as a Speech-page model.
 *
 * The phone downloads sherpa-onnx's small Chinese/English keyword-spotting
 * zipformer, keeps only the four files the detector loads (renamed to the
 * names native expects), writes the "Hey Mentra" keyword list, and moves the
 * finished folder into place in one rename. Native loads it from
 * `getModelPath()` (`BluetoothSdk.setWakeWordDetection(true, modelDir)`).
 */
const WAKE_WORD_MODEL = {
  code: "hey-mentra",
  displayName: "Hey Mentra",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2",
  sha256: "68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6",
  /** Archive size in bytes; the installed folder is about 5.4 MB. */
  size: 32_885_699,
  /** Archive file name -> installed name. Everything else in the archive is dropped. */
  files: {
    "encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx": "encoder.int8.onnx",
    "decoder-epoch-13-avg-2-chunk-8-left-64.onnx": "decoder.onnx",
    "joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx": "joiner.int8.onnx",
    "tokens.txt": "tokens.txt",
  } as Record<string, string>,
  /** Pronunciations of "Hey Mentra" with their boost and trigger threshold. */
  keywords: [
    "HH EY1 M EH1 N T R AH0 :3.2 #0.015 @HEY_MENTRA",
    "HH EY1 M AE1 N T R AH0 :3.2 #0.015 @HEY_MENTRA",
    "HH EY1 M IH1 N T R AH0 :3.2 #0.015 @HEY_MENTRA",
    "HH EY1 M IY1 T R AH0 :3.2 #0.015 @HEY_MENTRA",
    "HH EY1 M IH1 T R AH0 :3.2 #0.015 @HEY_MENTRA",
    "HH EY1 M EH1 T R AH0 :3.2 #0.015 @HEY_MENTRA",
  ].join("\n"),
}

/** Every file the native detector needs in its model directory. */
export const WAKE_WORD_MODEL_FILES = [...Object.values(WAKE_WORD_MODEL.files), "keywords.txt"]

export interface WakeWordModelInfo {
  code: string
  displayName: string
  size: number
  downloaded: boolean
}

interface DownloadJob {
  promise: Promise<void>
  jobId?: number
  cancelled: boolean
  progress: Set<(progress: DownloadProgress) => void>
  extraction: Set<(progress: ExtractionProgress) => void>
  lastProgress?: DownloadProgress
  lastExtraction?: ExtractionProgress
}

class WakeWordModelManager {
  private job?: DownloadJob

  get code(): string {
    return WAKE_WORD_MODEL.code
  }

  getModelDirectory(): string {
    return `${RNFS.DocumentDirectoryPath}/wake_word_models`
  }

  getModelPath(): string {
    return `${this.getModelDirectory()}/${WAKE_WORD_MODEL.code}`
  }

  async isModelAvailable(): Promise<boolean> {
    try {
      const dir = this.getModelPath()
      for (const file of WAKE_WORD_MODEL_FILES) {
        if (!(await RNFS.exists(`${dir}/${file}`))) return false
      }
      return true
    } catch (error) {
      console.warn("WAKE_WORD_MODEL: availability check failed:", error)
      return false
    }
  }

  async getInfo(): Promise<WakeWordModelInfo> {
    return {
      code: WAKE_WORD_MODEL.code,
      displayName: WAKE_WORD_MODEL.displayName,
      size: WAKE_WORD_MODEL.size,
      downloaded: await this.isModelAvailable(),
    }
  }

  isDownloading(): boolean {
    return this.job !== undefined
  }

  /** Download the model if it is missing. Concurrent callers share one download and its progress. */
  downloadModel(
    onProgress?: (progress: DownloadProgress) => void,
    onExtractionProgress?: (progress: ExtractionProgress) => void,
  ): Promise<void> {
    let job = this.job
    if (!job) {
      const created: DownloadJob = {
        promise: Promise.resolve(),
        cancelled: false,
        progress: new Set(),
        extraction: new Set(),
      }
      created.promise = (async () => {
        if (!(await this.isModelAvailable())) await this.downloadOnce(created)
      })().finally(() => {
        if (this.job === created) this.job = undefined
      })
      this.job = created
      job = created
    }
    const joined = job
    if (onProgress) {
      joined.progress.add(onProgress)
      if (joined.lastProgress) onProgress(joined.lastProgress)
    }
    if (onExtractionProgress) {
      joined.extraction.add(onExtractionProgress)
      if (joined.lastExtraction) onExtractionProgress(joined.lastExtraction)
    }
    return joined.promise.finally(() => {
      if (onProgress) joined.progress.delete(onProgress)
      if (onExtractionProgress) joined.extraction.delete(onExtractionProgress)
    })
  }

  async cancelDownload(): Promise<void> {
    const job = this.job
    if (!job) return
    job.cancelled = true
    if (job.jobId !== undefined) await RNFS.stopDownload(job.jobId)
  }

  async deleteModel(): Promise<void> {
    const path = this.getModelPath()
    if (await RNFS.exists(path)) await RNFS.unlink(path)
  }

  private report(job: DownloadJob, progress: DownloadProgress): void {
    job.lastProgress = progress
    for (const listener of job.progress) listener(progress)
  }

  private reportExtraction(job: DownloadJob, progress: ExtractionProgress): void {
    job.lastExtraction = progress
    for (const listener of job.extraction) listener(progress)
  }

  private async downloadOnce(job: DownloadJob): Promise<void> {
    const stamp = Date.now()
    const modelsDir = this.getModelDirectory()
    const finalPath = this.getModelPath()
    const archivePath = `${RNFS.TemporaryDirectoryPath}/${WAKE_WORD_MODEL.code}-${stamp}.tar.bz2`
    // Temporary folders sit next to the final one so the last step is a rename.
    const extractPath = `${modelsDir}/.extract-${WAKE_WORD_MODEL.code}-${stamp}`
    const stagingPath = `${modelsDir}/.staging-${WAKE_WORD_MODEL.code}-${stamp}`

    try {
      await RNFS.mkdir(modelsDir, {NSURLIsExcludedFromBackupKey: true})
      await this.removeStaleFolders(modelsDir)

      const result = RNFS.downloadFile({
        fromUrl: WAKE_WORD_MODEL.url,
        toFile: archivePath,
        progress: (res: RNFS.DownloadProgressCallbackResultT) => {
          const percentage = res.contentLength > 0 ? Math.round((res.bytesWritten / res.contentLength) * 100) : 0
          this.report(job, {
            jobId: res.jobId,
            bytesWritten: res.bytesWritten,
            contentLength: res.contentLength,
            percentage,
          })
        },
        progressDivider: 10,
        connectionTimeout: 30000,
        readTimeout: 30000,
      })
      job.jobId = result.jobId
      if (job.cancelled) await RNFS.stopDownload(result.jobId)
      const downloaded = await result.promise
      if (job.cancelled) throw new Error("Wake-word model download was cancelled")
      if (downloaded.statusCode !== 200) {
        throw new Error(`Wake-word model download failed with status code: ${downloaded.statusCode}`)
      }

      const digest = (await RNFS.hash(archivePath, "sha256")).toLowerCase()
      if (digest !== WAKE_WORD_MODEL.sha256) {
        throw new Error(`Wake-word model download is corrupt (sha256 ${digest})`)
      }

      this.reportExtraction(job, {percentage: 0})
      const subscription = BluetoothSdk.addListener("extraction_progress", (event) => {
        this.reportExtraction(job, {percentage: event.percentage})
      })
      try {
        if (!(await BluetoothSdk.extractTarBz2(archivePath, extractPath))) {
          throw new Error("Native extraction returned failure status")
        }
      } finally {
        subscription.remove()
      }

      await RNFS.mkdir(stagingPath)
      for (const [archiveName, installedName] of Object.entries(WAKE_WORD_MODEL.files)) {
        const source = await this.findExtracted(extractPath, archiveName)
        if (!source) throw new Error(`Wake-word model archive is missing ${archiveName}`)
        await RNFS.moveFile(source, `${stagingPath}/${installedName}`)
      }
      await RNFS.writeFile(`${stagingPath}/keywords.txt`, `${WAKE_WORD_MODEL.keywords}\n`, "utf8")

      if (await RNFS.exists(finalPath)) await RNFS.unlink(finalPath)
      await RNFS.moveFile(stagingPath, finalPath)
      this.reportExtraction(job, {percentage: 100})
    } finally {
      for (const path of [archivePath, extractPath, stagingPath]) {
        try {
          if (await RNFS.exists(path)) await RNFS.unlink(path)
        } catch (cleanupError) {
          console.warn(`WAKE_WORD_MODEL: cleanup of ${path} failed:`, cleanupError)
        }
      }
    }
  }

  /** Native extraction flattens the archive's top folder; also look one level down in case it doesn't. */
  private async findExtracted(root: string, name: string): Promise<string | undefined> {
    if (await RNFS.exists(`${root}/${name}`)) return `${root}/${name}`
    for (const entry of await RNFS.readDir(root)) {
      if (entry.isDirectory() && (await RNFS.exists(`${entry.path}/${name}`))) return `${entry.path}/${name}`
    }
    return undefined
  }

  /** Folders left behind by a download that was interrupted mid-way. */
  private async removeStaleFolders(modelsDir: string): Promise<void> {
    try {
      for (const entry of await RNFS.readDir(modelsDir)) {
        if (entry.name.startsWith(".extract-") || entry.name.startsWith(".staging-")) await RNFS.unlink(entry.path)
      }
    } catch (error) {
      console.warn("WAKE_WORD_MODEL: could not clean interrupted downloads:", error)
    }
  }
}

const wakeWordModelManager = new WakeWordModelManager()
export {WakeWordModelManager}
export default wakeWordModelManager
