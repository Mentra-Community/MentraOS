import {describe, expect, it} from "bun:test"

import {filePathOfUri, isFileUriInside, isNetworkUrl, isPathWithin, safeFileName, urlScheme} from "../miniappPaths"

describe("urlScheme and isNetworkUrl", () => {
  it("reads the scheme in any case, after leading spaces and controls", () => {
    expect(urlScheme("HTTPS://example.com")).toBe("https")
    expect(urlScheme(" \tfile:///etc/hosts")).toBe("file")
    expect(urlScheme("content://x/y")).toBe("content")
    expect(urlScheme("/var/mobile/x")).toBeNull()
    expect(urlScheme("relative/x")).toBeNull()
    expect(urlScheme(undefined)).toBeNull()
  })

  it("counts only http: and https: as the network", () => {
    for (const url of ["http://example.com", "https://example.com/a.pdf", "HTTP://10.0.0.2:8080/x"]) {
      expect(isNetworkUrl(url)).toBe(true)
    }
    for (const url of [
      "file:///var/mobile/Containers/Data/Application/X/Documents/mmkv/mmkv.default",
      "FILE:///etc/hosts",
      " file:///etc/hosts",
      "content://com.mentra.mentra.fileprovider/cache/x",
      "data:text/plain,hi",
      "javascript:alert(1)",
      "ftp://example.com/x",
      "/etc/hosts",
      "",
      42,
    ]) {
      expect(isNetworkUrl(url)).toBe(false)
    }
  })
})

describe("filePathOfUri", () => {
  it("decodes a file URI to its absolute path, with dot segments resolved", () => {
    expect(filePathOfUri("file:///var/mobile/Documents/a%20b.wav")).toBe("/var/mobile/Documents/a b.wav")
    expect(filePathOfUri("FILE://localhost/tmp/x")).toBe("/tmp/x")
    expect(filePathOfUri("file:///a/b/../../c/./d")).toBe("/c/d")
    expect(filePathOfUri("file:///a/%2e%2e/b")).toBe("/b")
    expect(filePathOfUri("file:///../../etc")).toBe("/etc")
    expect(filePathOfUri("file:///a//b/")).toBe("/a/b")
    expect(filePathOfUri("file:///a?x#y")).toBe("/a")
  })

  it("is null for anything that is not a local file URI", () => {
    expect(filePathOfUri("https://example.com/a")).toBeNull()
    expect(filePathOfUri("/var/mobile/a")).toBeNull()
    expect(filePathOfUri("file://evil.example.com/etc/hosts")).toBeNull()
    expect(filePathOfUri("file:relative")).toBeNull()
    expect(filePathOfUri("file:///a%00b")).toBeNull()
    expect(filePathOfUri("file:///a%zz")).toBeNull()
    expect(filePathOfUri(" file:///a")).toBeNull()
  })
})

describe("isPathWithin", () => {
  it("is true only at or below the directory", () => {
    expect(isPathWithin("/docs/mentra_blobs/p/com.a", "/docs/mentra_blobs/p/com.a/x.wav")).toBe(true)
    expect(isPathWithin("/docs/mentra_blobs/p/com.a/", "/docs/mentra_blobs/p/com.a/x.wav")).toBe(true)
    expect(isPathWithin("/docs/mentra_blobs/p/com.a", "/docs/mentra_blobs/p/com.a")).toBe(true)
    expect(isPathWithin("/docs/mentra_blobs/p/com.a", "/docs/mentra_blobs/p/com.ab/x.wav")).toBe(false)
    expect(isPathWithin("/docs/mentra_blobs/p/com.a", "/docs/mmkv/mmkv.default")).toBe(false)
    expect(isPathWithin("/docs/mentra_blobs/p/com.a", "/docs/mentra_blobs/p/com.a/../../mmkv")).toBe(false)
  })
})

describe("isFileUriInside", () => {
  const bundle = "file:///docs/lmas/com.acme.notes/1.0.0/"
  it("accepts an entry inside the bundle", () => {
    expect(isFileUriInside(bundle, "file:///docs/lmas/com.acme.notes/1.0.0/dist/background.js")).toBe(true)
  })
  it("refuses the bundle itself, a sibling version, another package and other URIs", () => {
    expect(isFileUriInside(bundle, bundle)).toBe(false)
    expect(isFileUriInside(bundle, "file:///docs/lmas/com.acme.notes/1.0.0-old/bg.js")).toBe(false)
    expect(isFileUriInside(bundle, "file:///docs/lmas/com.acme.notes/1.0.0/../2.0.0/bg.js")).toBe(false)
    expect(isFileUriInside(bundle, "file:///docs/lmas/com.other/1.0.0/bg.js")).toBe(false)
    expect(isFileUriInside(bundle, "https://example.com/bg.js")).toBe(false)
  })
  it("takes the host's absolute paths as well as its file URIs", () => {
    expect(isFileUriInside("/docs/lmas/com.acme.notes/1.0.0", "/docs/lmas/com.acme.notes/1.0.0/a b%.js")).toBe(true)
    expect(isFileUriInside("/docs/lmas/com.acme.notes/1.0.0", "/docs/lmas/com.acme.notes/1.0.0/../x.js")).toBe(false)
    expect(isFileUriInside("/docs/lmas/com.acme.notes/1.0.0", "/docs/lmas/com.acme.notes/1.0.0/a#/../../../x.js")).toBe(
      false,
    )
    expect(isFileUriInside(bundle, "/docs/lmas/com.acme.notes/1.0.0/dist/bg.js")).toBe(true)
  })
})

describe("safeFileName", () => {
  it("turns a path into one file name in the directory it is written to", () => {
    expect(safeFileName("../../Documents/mmkv/mmkv.default", "x")).toBe(".._.._Documents_mmkv_mmkv.default")
    expect(safeFileName("/etc/hosts", "x")).toBe("_etc_hosts")
    expect(safeFileName("..\\..\\x.txt", "x")).toBe(".._.._x.txt")
    expect(safeFileName("a\u0000b\nc‮gnp.exe", "x")).toBe("a_b_c_gnp.exe")
  })

  it("keeps a readable name", () => {
    expect(safeFileName("Meeting notes (Oct 24).txt", "x")).toBe("Meeting notes (Oct 24).txt")
    expect(safeFileName("Café & Co, été.pdf", "x")).toBe("Café & Co, été.pdf")
    expect(safeFileName("report.pdf", "x")).toBe("report.pdf")
  })

  it("never returns an empty name or a directory reference", () => {
    for (const name of ["", "   ", ".", "..", " .. ", undefined, null, 7]) {
      expect(safeFileName(name, "shared_file")).toBe("shared_file")
    }
    expect(safeFileName("..", "..")).toBe("_")
  })

  it("stays within file system name limits and keeps the extension", () => {
    const long = safeFileName(`${"a".repeat(500)}.wav`, "x")
    expect(long.length).toBeLessThanOrEqual(120)
    expect(long.endsWith(".wav")).toBe(true)
    // Each of these is three bytes in UTF-8; names are limited to 255 bytes.
    const wide = safeFileName(`${"文".repeat(200)}.txt`, "x")
    expect(Buffer.byteLength(wide, "utf8")).toBeLessThanOrEqual(200)
    expect(wide.endsWith(".txt")).toBe(true)
  })
})
