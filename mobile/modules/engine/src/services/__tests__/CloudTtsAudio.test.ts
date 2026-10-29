/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const Paths = {cache: ""}
const timers = new Map<number, () => void>()
let nextTimerId = 1
let download: (url: string, file: File) => Promise<File>

class File {
  uri: string
  constructor(...parts: Array<string | {uri: string}>) {
    this.uri = path.join(...parts.map((part) => (typeof part === "string" ? part : part.uri)))
  }
  get exists() {
    return fs.existsSync(this.uri)
  }
  get size() {
    return this.exists ? fs.statSync(this.uri).size : 0
  }
  delete() {
    fs.unlinkSync(this.uri)
  }
  static downloadFileAsync = mock((url: string, file: File, _options?: {idempotent?: boolean}) => download(url, file))
}

mock.module("expo-file-system", () => ({File, Paths}))
mock.module("../../utils/timers", () => ({
  BgTimer: {
    setTimeout: (callback: () => void) => {
      const id = nextTimerId++
      timers.set(id, callback)
      return id
    },
    clearTimeout: (id: number) => {
      timers.delete(id)
    },
  },
}))

const {cloudTtsDownloadTimeoutMs, downloadCloudTtsAudio} = await import("../CloudTtsAudio")

const url = "https://runtime.test/api/tts/speak?text=Hello"

function writeAudio(file: File, bytes = 4096) {
  fs.writeFileSync(file.uri, Buffer.alloc(bytes, 1))
  return file
}

function fireDeadline() {
  const pending = [...timers.values()]
  timers.clear()
  for (const callback of pending) callback()
}

function cachedFiles() {
  return fs.readdirSync(Paths.cache)
}

beforeEach(() => {
  Paths.cache = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-tts-"))
  timers.clear()
  File.downloadFileAsync.mockClear()
  download = async (_url, file) => writeAudio(file)
})

afterEach(() => {
  fs.rmSync(Paths.cache, {recursive: true, force: true})
})

describe("downloadCloudTtsAudio", () => {
  test("downloads the speech once into a local file and deletes it on cleanup", async () => {
    const audio = await downloadCloudTtsAudio(url, 5000)

    expect(File.downloadFileAsync).toHaveBeenCalledTimes(1)
    expect(File.downloadFileAsync.mock.calls[0][0]).toBe(url)
    expect(audio.audioUrl.startsWith(Paths.cache)).toBe(true)
    expect(audio.audioUrl.endsWith(".mp3")).toBe(true)
    expect(fs.statSync(audio.audioUrl).size).toBe(4096)
    expect(timers.size).toBe(0)

    await audio.cleanup?.()
    expect(cachedFiles()).toEqual([])
  })

  test("fails at the deadline and removes the file when the late download lands", async () => {
    let finish!: () => void
    download = (_url, file) =>
      new Promise((resolve) => {
        finish = () => resolve(writeAudio(file))
      })

    const result = downloadCloudTtsAudio(url, 5000)
    fireDeadline()
    await expect(result).rejects.toThrow("Cloud TTS download did not finish within 5000ms")

    finish()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cachedFiles()).toEqual([])
  })

  test("surfaces an HTTP failure without leaving a partial file", async () => {
    download = async (_url, file) => {
      writeAudio(file, 12)
      throw new Error("response has status 502")
    }

    await expect(downloadCloudTtsAudio(url, 5000)).rejects.toThrow("response has status 502")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cachedFiles()).toEqual([])
    expect(timers.size).toBe(0)
  })

  test("rejects an empty response", async () => {
    download = async (_url, file) => writeAudio(file, 0)

    await expect(downloadCloudTtsAudio(url, 5000)).rejects.toThrow("Cloud TTS download returned no audio")
    expect(cachedFiles()).toEqual([])
  })
})

describe("cloudTtsDownloadTimeoutMs", () => {
  test("keeps five seconds for a short reply and scales with longer text", () => {
    expect(cloudTtsDownloadTimeoutMs("")).toBe(5000)
    expect(cloudTtsDownloadTimeoutMs("x".repeat(80))).toBe(5240)
    expect(cloudTtsDownloadTimeoutMs("x".repeat(1800))).toBe(10400)
  })
})
