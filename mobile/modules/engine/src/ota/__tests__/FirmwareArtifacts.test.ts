import {beforeEach, expect, mock, test} from "bun:test"

const files = new Map<string, {bytes: number; digest: string; body: string}>()
const requests: string[] = []
let downloaded = {bytes: 123, digest: "a".repeat(64), body: "{}"}
let statusCode = 200
let progressListener: ((event: {destination: string; bytesWritten: number; contentLength: number}) => void) | null =
  null
let subscriptions = 0

mock.module("@dr.pogodin/react-native-fs", () => ({
  DocumentDirectoryPath: "/documents",
  mkdir: async (path: string) => {
    files.set(path, {bytes: 0, digest: "", body: ""})
  },
  exists: async (path: string) => files.has(path),
  unlink: async (path: string) => {
    for (const key of files.keys()) if (key === path || key.startsWith(`${path}/`)) files.delete(key)
  },
  stat: async (path: string) => ({size: files.get(path)!.bytes}),
  hash: async (path: string) => files.get(path)!.digest,
  readFile: async (path: string) => files.get(path)!.body,
  moveFile: async (from: string, to: string) => {
    files.set(to, files.get(from)!)
    files.delete(from)
  },
}))
mock.module("@mentra/bluetooth-sdk/ota-transport", () => ({
  otaServer: {
    onArtifactDownloadProgress: (listener: typeof progressListener) => {
      progressListener = listener
      subscriptions++
      return {
        remove: () => {
          subscriptions--
          progressListener = null
        },
      }
    },
    downloadArtifact: async (_source: string, destination: string) => {
      requests.push(destination)
      files.set(destination, {...downloaded})
      progressListener?.({destination: "/another-session/image.part", bytesWritten: 999, contentLength: 999})
      progressListener?.({destination, bytesWritten: downloaded.bytes, contentLength: downloaded.bytes})
      return {statusCode, bytesWritten: downloaded.bytes}
    },
  },
}))

const {stageFirmwareArtifact, fetchPinnedFirmwareManifest} = await import("../FirmwareArtifacts")
const descriptor = {url: "https://example.invalid/image", sha256: "a".repeat(64), size: 123}
beforeEach(() => {
  files.clear()
  requests.length = 0
  statusCode = 200
  subscriptions = 0
  downloaded = {bytes: 123, digest: "a".repeat(64), body: "{}"}
})

test("only verified files leave staging, and one session cannot clean another's artifact", async () => {
  const progress: (number | null)[] = []
  const first = await stageFirmwareArtifact(descriptor, (value) => progress.push(value))
  const second = await stageFirmwareArtifact(descriptor)
  expect(first.path).not.toBe(second.path)
  expect(progress).toEqual([100])
  expect(subscriptions).toBe(0)
  expect([...files.keys()].some((key) => key.endsWith(".part"))).toBe(false)
  await first.release()
  expect(files.has(second.path)).toBe(true)
  await first.release()
  await second.release()
  expect(files.size).toBe(0)
})

test.each(["size", "digest", "http"])("%s verification failure removes partial data and observers", async (failure) => {
  if (failure === "size") downloaded.bytes--
  if (failure === "digest") downloaded.digest = "b".repeat(64)
  if (failure === "http") statusCode = 404
  await expect(stageFirmwareArtifact(descriptor)).rejects.toThrow()
  expect(files.size).toBe(0)
  expect(subscriptions).toBe(0)
})

test("manifest hash verification happens before parsing even valid JSON", async () => {
  downloaded = {bytes: 20, digest: "b".repeat(64), body: '{"schemaVersion":1}'}
  await expect(fetchPinnedFirmwareManifest({url: descriptor.url, sha256: descriptor.sha256})).rejects.toThrow("SHA-256")
  expect(files.size).toBe(0)
  downloaded.digest = descriptor.sha256
  expect(await fetchPinnedFirmwareManifest({url: descriptor.url, sha256: descriptor.sha256})).toEqual({
    schemaVersion: 1,
  })
  expect(files.size).toBe(0)
})

test("AR99's optional MD5 is honored without imposing a new required SHA-256", async () => {
  downloaded.digest = "e".repeat(32)
  const file = await stageFirmwareArtifact({url: descriptor.url, md5: "E".repeat(32)})
  await file.release()
  downloaded.digest = "f".repeat(32)
  await expect(stageFirmwareArtifact({url: descriptor.url, md5: "E".repeat(32)})).rejects.toThrow("MD5")
})
