/// <reference types="bun-types" />

import {beforeEach, expect, mock, test} from "bun:test"

import {fakeRnfs, files, resetFakeRnfs, writeFiles} from "./fakeRnfs"

const MODEL_FILES = [
  "duration_predictor.int8.onnx",
  "text_encoder.int8.onnx",
  "vector_estimator.int8.onnx",
  "vocoder.int8.onnx",
  "tts.json",
  "unicode_indexer.bin",
  "voice.bin",
]
let extractedFiles = MODEL_FILES
const extract = mock(async (_source: string, destination: string) => {
  writeFiles(destination, extractedFiles)
  return true
})
mock.module("@mentra/bluetooth-sdk", () => ({
  default: {
    extractTarBz2: extract,
    validateTtsModel: async () => true,
    setTtsModelDetails: async () => {},
    getTtsModelPath: async () => "",
    getTtsModelLanguage: async () => "",
    addListener: () => ({remove: () => {}}),
  },
}))
mock.module("@dr.pogodin/react-native-fs", () => fakeRnfs)
const manager = (await import("../TTSModelManager")).default

beforeEach(() => {
  resetFakeRnfs()
  extractedFiles = MODEL_FILES
  extract.mockClear()
})

test("extracts into a temporary folder and renames it into place", async () => {
  await manager.downloadModel()
  const destination = extract.mock.calls[0]?.[1] ?? ""
  expect(destination).toStartWith("/documents/tts_models/.partial-supertonic-")
  expect(await manager.isModelAvailable()).toBe(true)
  expect([...files.keys()].some((path) => path.includes(".partial-"))).toBe(false)
})

test("a truncated extract never reaches the final folder", async () => {
  extractedFiles = MODEL_FILES.slice(0, 3)
  await expect(manager.downloadModel()).rejects.toThrow("incomplete")
  expect(await manager.isModelAvailable()).toBe(false)
  expect([...files.keys()].filter((path) => path.startsWith("/documents/tts_models/"))).toEqual([])
})
