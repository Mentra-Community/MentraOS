/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

import {autoDownload, downloads, fakeRnfs, files, resetFakeRnfs, stopDownload, writeFiles} from "./fakeRnfs"

const MODEL_FILES = ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"]
let storedPath = ""
const setDetails = mock(async (path: string, _language: string) => {
  storedPath = path
})
/** What native extraction writes into its destination; null fails the extraction. */
let extractedFiles: string[] | null = MODEL_FILES
const extract = mock(async (_source: string, destination: string) => {
  if (!extractedFiles) return false
  writeFiles(destination, extractedFiles)
  return true
})
mock.module("@mentra/bluetooth-sdk", () => ({
  default: {
    getSttModelPath: async () => storedPath,
    setSttModelDetails: setDetails,
    validateSttModel: async () => true,
    extractTarBz2: extract,
    addListener: () => ({remove: () => {}}),
  },
}))
mock.module("react-native", () => ({Platform: {OS: "android"}}))
mock.module("@dr.pogodin/react-native-fs", () => fakeRnfs)
const manager = (await import("../STTModelManager")).default

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(async () => {
  resetFakeRnfs()
  storedPath = ""
  extractedFiles = MODEL_FILES
  setDetails.mockClear()
  extract.mockClear()
  stopDownload.mockClear()
  manager.setCurrentLanguage("en-kroko")
})

describe("speech-to-text catalog", () => {
  test("lists one model per language, with Kroko as English and the default", () => {
    const languages = manager.getAvailableLanguages()
    expect(languages.filter((language) => language.languageCode === "en-US").map((l) => l.code)).toEqual(["en-kroko"])
    expect(languages.find((language) => language.code === "en-kroko")?.displayName).toBe("English")
    expect(new Set(languages.map((language) => language.languageCode)).size).toBe(languages.length)
    expect(manager.getCurrentLanguage()).toBe("en-kroko")
  })

  test("still recognizes a saved old English model without listing it", async () => {
    storedPath = "/documents/stt_models/en"
    writeFiles("/documents/stt_models/en", MODEL_FILES)
    expect(await manager.getCurrentLanguageFromPreferences()).toBe("en")
    expect(await manager.isModelAvailable()).toBe(true)
    expect(manager.getBcp47ForLanguage()).toBe("en-US")
    expect(manager.getLegacyReplacement("en")).toBe("en-kroko")
    expect(manager.getLegacyReplacement("en-kroko")).toBeUndefined()
    expect((await manager.getAllLanguageInfo()).some((info) => info.code === "en")).toBe(false)
  })

  test("never turns a saved model into a different one", async () => {
    storedPath = "/documents/stt_models/fr"
    expect(await manager.getCurrentLanguageFromPreferences()).toBe("fr")
    expect(setDetails).not.toHaveBeenCalled()
    storedPath = "/documents/stt_models/en-parakeet-v2"
    expect(await manager.getCurrentLanguageFromPreferences()).toBe("")
    expect(setDetails).not.toHaveBeenCalled()
  })
})

describe("activation", () => {
  test("persists the native path before notifying selection listeners", async () => {
    writeFiles("/documents/stt_models/fr", MODEL_FILES)
    const observed: string[] = []
    const off = manager.onSelectionChanged(() => observed.push(storedPath))
    await manager.activateLanguage("fr")
    expect(setDetails).toHaveBeenLastCalledWith("/documents/stt_models/fr", "fr-FR")
    expect(observed).toEqual(["/documents/stt_models/fr"])
    off()
  })

  test("keeps the current choice when the model is missing or native persistence fails", async () => {
    await expect(manager.activateLanguage("de")).rejects.toThrow("not downloaded")
    writeFiles("/documents/stt_models/de", MODEL_FILES)
    setDetails.mockImplementationOnce(async () => {
      throw new Error("native write failed")
    })
    await expect(manager.activateLanguage("de")).rejects.toThrow("native write failed")
    expect(manager.getCurrentLanguage()).toBe("en-kroko")
  })
})

describe("downloads", () => {
  test("extract into a temporary folder and rename it into place when complete", async () => {
    let destination = ""
    extract.mockImplementationOnce(async (_source: string, dest: string) => {
      destination = dest
      writeFiles(dest, MODEL_FILES)
      // Nothing is visible at the final path while extraction runs.
      expect(await manager.isModelAvailable("fr")).toBe(false)
      return true
    })
    await manager.downloadModel("fr")
    expect(destination).not.toBe("/documents/stt_models/fr")
    expect(destination.startsWith("/documents/stt_models/.partial-fr-")).toBe(true)
    expect(await manager.isModelAvailable("fr")).toBe(true)
    expect([...files.keys()].some((path) => path.includes(".partial-"))).toBe(false)
    expect(setDetails).not.toHaveBeenCalled()
  })

  test("a truncated extract never reaches the final folder", async () => {
    extractedFiles = ["encoder.onnx", "tokens.txt"]
    await expect(manager.downloadModel("fr")).rejects.toThrow("incomplete or invalid")
    expect(await manager.isModelAvailable("fr")).toBe(false)
    expect([...files.keys()].filter((path) => path.startsWith("/documents/stt_models/"))).toEqual([])
  })

  test("removes extracts left by an interrupted download", async () => {
    writeFiles("/documents/stt_models/.partial-fr-123", ["encoder.onnx"])
    writeFiles("/documents/stt_models/de", MODEL_FILES)
    await manager.downloadModel("fr")
    expect(files.has("/documents/stt_models/.partial-fr-123/encoder.onnx")).toBe(false)
    expect(await manager.isModelAvailable("de")).toBe(true)
  })

  test("every caller of an in-progress download gets its progress", async () => {
    autoDownload.enabled = false
    const first: number[] = []
    const second: number[] = []
    const a = manager.downloadModel("fr", (p) => first.push(p.percentage))
    await settle()
    downloads[0].progress?.({jobId: 1, bytesWritten: 25, contentLength: 100})
    const b = manager.downloadModel("fr", (p) => second.push(p.percentage))
    downloads[0].progress?.({jobId: 1, bytesWritten: 50, contentLength: 100})
    expect(downloads).toHaveLength(1)
    downloads[0].finish()
    await Promise.all([a, b])
    expect(first).toEqual([25, 50])
    expect(second).toEqual([25, 50])
    expect(extract).toHaveBeenCalledTimes(1)
  })

  test("cancel stops only the named download", async () => {
    autoDownload.enabled = false
    const french = manager.downloadModel("fr")
    const german = manager.downloadModel("de")
    await settle()
    expect(downloads).toHaveLength(2)
    await manager.cancelDownload("fr")
    await expect(french).rejects.toThrow()
    expect(manager.isDownloading("de")).toBe(true)
    downloads[1].finish()
    await german
    expect(await manager.isModelAvailable("de")).toBe(true)
    expect(await manager.isModelAvailable("fr")).toBe(false)
  })
})
