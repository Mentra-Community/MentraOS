/// <reference types="bun-types" />

import {beforeEach, expect, mock, test} from "bun:test"

import {fakeRnfs, files, hashOverride, resetFakeRnfs, writeFiles} from "./fakeRnfs"

const ARCHIVE_SHA256 = "68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6"
const ARCHIVE_FILES = [
  "decoder-epoch-13-avg-2-chunk-16-left-64.onnx",
  "decoder-epoch-13-avg-2-chunk-8-left-64.onnx",
  "en.phone",
  "encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx",
  "encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx",
  "encoder-epoch-13-avg-2-chunk-8-left-64.onnx",
  "joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx",
  "joiner-epoch-13-avg-2-chunk-8-left-64.onnx",
  "test_wavs/keywords.txt",
  "tokens.txt",
]
let nested = false
const extract = mock(async (_source: string, destination: string) => {
  for (const name of ARCHIVE_FILES) files.set(`${destination}${nested ? "/model" : ""}/${name}`, name)
  return true
})
mock.module("@mentra/bluetooth-sdk", () => ({
  default: {extractTarBz2: extract, addListener: () => ({remove: () => {}})},
}))
mock.module("@dr.pogodin/react-native-fs", () => fakeRnfs)
const manager = (await import("../WakeWordModelManager")).default

beforeEach(() => {
  resetFakeRnfs()
  nested = false
  extract.mockClear()
})

function trackArchiveHash(digest: string) {
  // The archive lands at a time-stamped temp path; answer for whichever one is hashed.
  hashOverride.fn = (path) => (path.startsWith("/tmp/") ? digest : undefined)
  return () => {
    hashOverride.fn = undefined
  }
}

test.each([false, true])("installs only the four detector files plus keywords.txt (nested=%p)", async (inner) => {
  nested = inner
  const restore = trackArchiveHash(ARCHIVE_SHA256)
  try {
    await manager.downloadModel()
  } finally {
    restore()
  }
  const dir = "/documents/wake_word_models/hey-mentra"
  const installed = [...files.keys()].filter((path) => path.startsWith(`${dir}/`)).sort()
  expect(installed).toEqual(
    ["decoder.onnx", "encoder.int8.onnx", "joiner.int8.onnx", "keywords.txt", "tokens.txt"].map((n) => `${dir}/${n}`),
  )
  expect(files.get(`${dir}/encoder.int8.onnx`)).toBe("encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx")
  expect(files.get(`${dir}/decoder.onnx`)).toBe("decoder-epoch-13-avg-2-chunk-8-left-64.onnx")
  expect(files.get(`${dir}/joiner.int8.onnx`)).toBe("joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx")
  expect(files.get(`${dir}/keywords.txt`)).toBe(
    [
      "HH EY1 M EH1 N T R AH0 :3.2 #0.015 @HEY_MENTRA",
      "HH EY1 M AE1 N T R AH0 :3.2 #0.015 @HEY_MENTRA",
      "HH EY1 M IH1 N T R AH0 :3.2 #0.015 @HEY_MENTRA",
      "HH EY1 M IY1 T R AH0 :3.2 #0.015 @HEY_MENTRA",
      "HH EY1 M IH1 T R AH0 :3.2 #0.015 @HEY_MENTRA",
      "HH EY1 M EH1 T R AH0 :3.2 #0.015 @HEY_MENTRA",
      "",
    ].join("\n"),
  )
  expect(await manager.isModelAvailable()).toBe(true)
  // Temporary archive and folders are gone.
  expect([...files.keys()].filter((path) => !path.startsWith(`${dir}/`))).toEqual([])
})

test("a corrupt archive installs nothing", async () => {
  const restore = trackArchiveHash("deadbeef")
  try {
    await expect(manager.downloadModel()).rejects.toThrow("corrupt")
  } finally {
    restore()
  }
  expect(extract).not.toHaveBeenCalled()
  expect(await manager.isModelAvailable()).toBe(false)
  expect([...files.keys()]).toEqual([])
})

test("an existing install is reused and delete removes it", async () => {
  writeFiles("/documents/wake_word_models/hey-mentra", [
    "encoder.int8.onnx",
    "decoder.onnx",
    "joiner.int8.onnx",
    "tokens.txt",
    "keywords.txt",
  ])
  await manager.downloadModel()
  expect(extract).not.toHaveBeenCalled()
  expect((await manager.getInfo()).downloaded).toBe(true)
  await manager.deleteModel()
  expect(await manager.isModelAvailable()).toBe(false)
})
