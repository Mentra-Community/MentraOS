/**
 * In-memory stand-in for @dr.pogodin/react-native-fs: enough of the API for
 * the speech model managers (paths are plain strings, folders are implied by
 * their contents or created with mkdir).
 */
import {mock} from "bun:test"

export const files = new Map<string, string>()
export const dirs = new Set<string>()

export interface FakeDownload {
  fromUrl: string
  toFile: string
  progress?: (res: {jobId: number; bytesWritten: number; contentLength: number}) => void
  finish: (statusCode?: number, contents?: string) => void
  fail: (error: Error) => void
}

export const downloads: FakeDownload[] = []
let nextJobId = 1
/** When true, downloadFile resolves on its own with `autoContents`. */
export const autoDownload = {enabled: true, contents: "archive", statusCode: 200}
export const hashes = new Map<string, string>()
/** Answers `hash()` for any path it returns a value for (e.g. a time-stamped temp file). */
export const hashOverride: {fn?: (path: string) => string | undefined} = {}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

export function resetFakeRnfs(): void {
  files.clear()
  dirs.clear()
  downloads.length = 0
  hashes.clear()
  hashOverride.fn = undefined
  autoDownload.enabled = true
  autoDownload.contents = "archive"
  autoDownload.statusCode = 200
}

export function writeFiles(dir: string, names: string[], contents = "x"): void {
  dirs.add(dir)
  for (const name of names) files.set(`${dir}/${name}`, contents)
}

export const stopDownload = mock((jobId: number) => {
  const download = downloads.find((d) => (d as unknown as {jobId: number}).jobId === jobId)
  download?.fail(new Error("Download has been aborted"))
})

export const fakeRnfs = {
  DocumentDirectoryPath: "/documents",
  TemporaryDirectoryPath: "/tmp",
  exists: async (path: string) =>
    files.has(path) || dirs.has(path) || [...files.keys()].some((file) => under(file, path)),
  mkdir: async (path: string) => {
    dirs.add(path)
  },
  unlink: async (path: string) => {
    for (const file of [...files.keys()]) if (under(file, path)) files.delete(file)
    for (const dir of [...dirs]) if (under(dir, path)) dirs.delete(dir)
  },
  moveFile: async (from: string, to: string) => {
    for (const [file, contents] of [...files]) {
      if (!under(file, from)) continue
      files.delete(file)
      files.set(to + file.slice(from.length), contents)
    }
    for (const dir of [...dirs]) {
      if (!under(dir, from)) continue
      dirs.delete(dir)
      dirs.add(to + dir.slice(from.length))
    }
  },
  writeFile: async (path: string, contents: string) => {
    files.set(path, contents)
  },
  readDir: async (path: string) => {
    const names = new Map<string, boolean>()
    for (const entry of [...files.keys(), ...dirs]) {
      if (!entry.startsWith(`${path}/`)) continue
      const rest = entry.slice(path.length + 1)
      const name = rest.split("/")[0]
      const isDir = rest.includes("/") || dirs.has(`${path}/${name}`)
      names.set(name, (names.get(name) ?? false) || isDir)
    }
    return [...names].map(([name, isDir]) => ({name, path: `${path}/${name}`, isDirectory: () => isDir}))
  },
  hash: async (path: string, _algorithm: string) => hashOverride.fn?.(path) ?? hashes.get(path) ?? "unknown",
  stopDownload,
  downloadFile: (options: {
    fromUrl: string
    toFile: string
    progress?: (res: {jobId: number; bytesWritten: number; contentLength: number}) => void
  }) => {
    const jobId = nextJobId++
    let resolve!: (result: {statusCode: number}) => void
    let reject!: (error: Error) => void
    const promise = new Promise<{statusCode: number}>((res, rej) => {
      resolve = res
      reject = rej
    })
    const download: FakeDownload & {jobId: number} = {
      jobId,
      fromUrl: options.fromUrl,
      toFile: options.toFile,
      progress: options.progress,
      finish: (statusCode = 200, contents = "archive") => {
        files.set(options.toFile, contents)
        resolve({statusCode})
      },
      fail: (error) => reject(error),
    }
    downloads.push(download)
    if (autoDownload.enabled) queueMicrotask(() => download.finish(autoDownload.statusCode, autoDownload.contents))
    return {jobId, promise}
  },
}
