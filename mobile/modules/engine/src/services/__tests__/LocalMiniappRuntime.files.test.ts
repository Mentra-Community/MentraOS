/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {FakeDirectory, FakePaths, crustRealpath, fakeExpoFileSystem, uriOf, useFakeRoots} from "./fakeExpoFileSystem"

mock.module("expo-file-system", () => fakeExpoFileSystem)
mock.module("react-native", () => ({Linking: {openURL: async () => {}}}))
mock.module("react-native-share", () => ({default: {open: async () => {}}}))
mock.module("@mentra/miniapp", () => ({MiniappErrorCode: {INVALID_ARGUMENT: "INVALID_ARGUMENT"}}))
mock.module("@mentra/crust", () => ({default: {canonicalFilePath: crustRealpath}}))
const {MiniappSystemActions} = await import("../MiniappSystemActions")

// Exercise the real handler without booting the engine's native dependencies,
// following LocalMiniappRuntime.speech.test.ts.
const source = fs.readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const start = source.search(/^ {2}private handlePlayAudio\(/m)
if (start < 0) throw new Error("Missing runtime method handlePlayAudio")
const rest = source.slice(start)
const method = rest.slice(0, rest.search(/^ {2}\}$/m) + 3)
const compiled = new Bun.Transpiler({loader: "ts"}).transformSync(`class Host { ${method} }`)

const pkg = "com.mentra.recorder"
let root: string
let ownDir: string
let plays: string[]
let host: {
  handlePlayAudio: (packageName: string, payload: Record<string, unknown>, requestId?: string) => void
  sendResult: ReturnType<typeof mock>
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-files-test-"))
  useFakeRoots(root)
  ownDir = path.join(FakePaths.document.path, "mentra_blobs", "p", pkg)
  fs.mkdirSync(ownDir, {recursive: true})
  plays = []
  const audioPlaybackService = {play: (request: {audioUrl: string}) => plays.push(request.audioUrl)}
  const Host = new Function("audioPlaybackService", "MiniappErrorCode", `${compiled}; return Host`)(
    audioPlaybackService,
    {
      INTERNAL: "INTERNAL",
      INVALID_ARGUMENT: "INVALID_ARGUMENT",
    },
  )
  const instance = new Host()
  instance.cancelSpeech = () => {}
  instance.setSpeakerState = () => {}
  instance.sendResult = mock(() => {})
  instance.systemActions = new MiniappSystemActions({
    sendResult: instance.sendResult,
    ownFilesDirectory: (packageName: string) => new FakeDirectory(FakePaths.document, "mentra_blobs", "p", packageName),
  })
  host = instance
})

afterEach(() => {
  fs.rmSync(root, {recursive: true, force: true})
})

describe("play_audio", () => {
  test("plays network and data URLs and the miniapp's own recordings", () => {
    const recording = path.join(ownDir, "rec.wav")
    fs.writeFileSync(recording, "RIFF")
    for (const audioUrl of ["https://cdn.example.com/a.mp3", "data:audio/wav;base64,UklGRg==", uriOf(recording)]) {
      host.handlePlayAudio(pkg, {audioUrl}, "r")
    }
    expect(plays).toEqual(["https://cdn.example.com/a.mp3", "data:audio/wav;base64,UklGRg==", uriOf(recording)])
  })

  test("never opens another file on the phone", () => {
    const other = path.join(FakePaths.document.path, "mmkv", "mmkv.default")
    fs.mkdirSync(path.dirname(other), {recursive: true})
    fs.writeFileSync(other, "refresh-token")
    for (const audioUrl of [uriOf(other), `file://${ownDir}/../../../mmkv/mmkv.default`, "content://x/y", other]) {
      host.sendResult.mockClear()
      host.handlePlayAudio(pkg, {audioUrl}, "r")
      expect(host.sendResult.mock.calls.at(-1)?.[2]).toBe(false)
      expect((host.sendResult.mock.calls.at(-1)?.[4] as {code: string}).code).toBe("INVALID_ARGUMENT")
    }
    expect(plays).toEqual([])
  })
})
