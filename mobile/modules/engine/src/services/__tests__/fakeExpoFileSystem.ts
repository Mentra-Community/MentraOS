/**
 * An expo-file-system stand-in on the real file system, for tests about where
 * files land. Like expo, it joins path parts with a normalizing join (so `..`
 * in a name walks up) and gives `file://` URIs. Install it with
 * `mock.module("expo-file-system", () => fakeExpoFileSystem)` and set the roots
 * with `useFakeRoots`. `crustRealpath` stands in for Crust's canonicalFilePath.
 */
import {mock} from "bun:test"
import * as fs from "node:fs"
import * as nodePath from "node:path"

const encode = (path: string) =>
  path.replace(/%/g, "%25").replace(/ /g, "%20").replace(/#/g, "%23").replace(/\?/g, "%3F")
export const uriOf = (path: string) => `file://${encode(path)}`
export const pathOf = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ""))

type Part = string | {uri: string}
function joinParts(parts: Part[]): string {
  const [first, ...rest] = parts.map((p) => (typeof p === "string" ? p : p.uri))
  return nodePath.join(first.startsWith("file://") ? pathOf(first) : first, ...rest)
}

export class FakeDirectory {
  readonly path: string
  constructor(...parts: Part[]) {
    this.path = joinParts(parts)
  }
  get uri() {
    return `${uriOf(this.path)}/`
  }
  get name() {
    return nodePath.basename(this.path)
  }
  get exists() {
    return fs.existsSync(this.path) && fs.statSync(this.path).isDirectory()
  }
  create(options: {intermediates?: boolean} = {}) {
    if (fs.existsSync(this.path)) throw new Error(`${this.path} already exists`)
    fs.mkdirSync(this.path, {recursive: options.intermediates ?? false})
  }
  list() {
    // As expo lists them: a link to a directory is a directory; a link to nothing is a file.
    const isDirectory = (path: string) => {
      try {
        return fs.statSync(path).isDirectory()
      } catch {
        return false
      }
    }
    return fs
      .readdirSync(this.path)
      .map((name) =>
        isDirectory(nodePath.join(this.path, name)) ? new FakeDirectory(this.path, name) : new FakeFile(this.path, name),
      )
  }
  delete() {
    fs.rmSync(this.path, {recursive: true})
  }
}

export class FakeFile {
  readonly path: string
  constructor(...parts: Part[]) {
    this.path = joinParts(parts)
  }
  get uri() {
    return uriOf(this.path)
  }
  get name() {
    return nodePath.basename(this.path)
  }
  get exists() {
    return fs.existsSync(this.path) && fs.statSync(this.path).isFile()
  }
  get size() {
    return fs.statSync(this.path).size
  }
  write(value: string, options: {encoding?: "base64" | "utf8"} = {}) {
    fs.writeFileSync(this.path, options.encoding === "base64" ? Buffer.from(value, "base64") : value)
  }
  copy(target: FakeFile) {
    fs.copyFileSync(this.path, target.path)
  }
  textSync() {
    return fs.readFileSync(this.path, "utf8")
  }
  delete() {
    fs.unlinkSync(this.path)
  }
  /** Writes `downloaded <url>` to the target, as a download of that URL would. */
  static downloadFileAsync = mock(async (url: string, target: FakeFile, _options?: unknown) => {
    fs.writeFileSync(target.path, `downloaded ${url}`)
    return target
  })
}

export const FakePaths = {
  cache: new FakeDirectory("/nonexistent-cache"),
  document: new FakeDirectory("/nonexistent-documents"),
}

/** Point Paths.cache and Paths.document at fresh directories under `root`. */
export function useFakeRoots(root: string) {
  for (const name of ["cache", "document"] as const) {
    fs.mkdirSync(nodePath.join(root, name), {recursive: true})
    FakePaths[name] = new FakeDirectory(root, name)
  }
}

export const fakeExpoFileSystem = {Directory: FakeDirectory, File: FakeFile, Paths: FakePaths}

/** Crust's canonicalFilePath: the real path of an existing file, else null. */
export function crustRealpath(path: string): string | null {
  try {
    return fs.realpathSync(path)
  } catch {
    return null
  }
}
