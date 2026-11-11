/// <reference types="bun-types" />

import {describe, expect, mock, test} from "bun:test"
import {readFileSync} from "node:fs"

// Same approach as LocalMiniappRuntime.fleetPhoto.test.ts: run the shipped methods against faked I/O.
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const start = source.search(/^ {2}private async takeLocalPhoto\(/m)
if (start < 0) throw new Error("Missing runtime method takeLocalPhoto")
const handler = source.indexOf("  private async handlePhoto(", start)
if (handler < 0) throw new Error("Missing runtime method handlePhoto")
const end = source.slice(handler).search(/^ {2}}$/m)
if (end < 0) throw new Error("Missing end of runtime method handlePhoto")
const compiled = new Bun.Transpiler({loader: "ts"}).transformSync(
  `class Host { ${source.slice(start, handler + end + 3)} }`,
)

const PACKAGE = "com.mentra.camera"

class PhotoError extends Error {
  constructor(readonly code: string, message: string, readonly stage?: string, readonly transport?: string) {
    super(message)
  }
}

function fixture(opts: {storeFails?: boolean; screenOrigin?: string | null; photoPauseHeld?: boolean} = {}) {
  const takePhoto = mock(async () => ({
    photoUrl: "https://r2.test/p.jpg",
    mimeType: "image/jpeg",
    size: -1,
    requestId: "rq-77",
  }))
  const takeLocalPhoto = mock(async () => ({
    fileUri: "file:///cache/mentra_local_photos/photo_1.jpg",
    mimeType: "image/jpeg",
    size: 61234,
    requestId: "p1abc",
  }))
  const storeExpiringFile = mock((_pkg: string, key: string, _uri: string, mimeType: string) => {
    if (opts.storeFails) throw new Error("disk full")
    return {
      key,
      mimeType,
      bytes: 61234,
      expiresAt: 1_800_000_000_000,
      uri: "file:///documents/mentra_blobs/core.mu_1.p/com.mentra.camera/mywpiww0-abc.jpg",
    }
  })
  const discardFile = mock((_uri: string) => {})
  const dataUrlOf = mock(
    async (_pkg: string, _key: string, _maxBytes: number): Promise<string | null> => "data:image/jpeg;base64,/9j/",
  )
  // As miniappScreenOrigin.miniappFileUrl: null for a screen the app doesn't serve.
  const origin = opts.screenOrigin === undefined ? "miniapp://com.mentra.camera" : opts.screenOrigin
  const miniappFileUrl = mock((_pkg: string, fileName: string) =>
    origin ? `${origin}/.mentra/files/${fileName}` : null,
  )
  const Host = new Function(
    "phonePhotoCoordinator",
    "fleetEvents",
    "parsePhotoCompression",
    "logPermissionNotDeclared",
    "MiniappRequestType",
    "MiniappErrorCode",
    "PhotoError",
    "EXPIRING_BLOB_TTL_MS",
    "miniappFileUrl",
    "PHOTO_DATA_URL_MAX_BYTES",
    "acsMeetingService",
    `${compiled}; return Host`,
  )(
    {takePhoto, takeLocalPhoto},
    {photo: () => {}},
    (value: unknown) => value ?? "none",
    () => {},
    {PHOTO: "photo"},
    {PERMISSION_NOT_DECLARED: "PERMISSION_NOT_DECLARED", INTERNAL: "INTERNAL"},
    PhotoError,
    30 * 60 * 1000,
    miniappFileUrl,
    1024 * 1024,
    {photoPauseHeld: () => opts.photoPauseHeld === true},
  )
  const host = new Host()
  const results: Array<{ok: boolean; data?: unknown; error?: {code?: string; stage?: string}}> = []
  host.connectedApps = new Map([[PACKAGE, {installedManifest: {permissions: [{type: "CAMERA"}]}}]])
  host.blobStore = {storeExpiringFile, discardFile, dataUrlOf}
  host.sendResult = (_pkg: string, _requestId: string | undefined, ok: boolean, data?: unknown, error?: never) => {
    results.push({ok, data, error})
  }
  return {host, results, takePhoto, takeLocalPhoto, storeExpiringFile, discardFile, dataUrlOf, miniappFileUrl}
}

describe("handlePhoto with local delivery", () => {
  test("a photo for the phone may come from a relayed stream, unless Call paused the stream for it", async () => {
    const f = fixture()
    await f.host.handlePhoto(PACKAGE, {delivery: "local"}, "req-1")
    expect(f.takeLocalPhoto).toHaveBeenCalledWith(PACKAGE, expect.objectContaining({streamFrame: true}))

    const paused = fixture({photoPauseHeld: true})
    await paused.host.handlePhoto(PACKAGE, {delivery: "local"}, "req-2")
    expect(paused.takeLocalPhoto).toHaveBeenCalledWith(PACKAGE, expect.objectContaining({streamFrame: false}))
  })

  test("a request for local delivery gets an expiring blob, and no cloud photo is requested", async () => {
    const f = fixture()
    await f.host.handlePhoto(PACKAGE, {delivery: "local", size: "low", saveToGallery: true}, "req-1")
    expect(f.takePhoto).not.toHaveBeenCalled()
    expect(f.takeLocalPhoto).toHaveBeenCalledWith(PACKAGE, expect.objectContaining({size: "low", saveToGallery: true}))
    expect(f.storeExpiringFile).toHaveBeenCalledWith(
      PACKAGE,
      "photo/p1abc",
      "file:///cache/mentra_local_photos/photo_1.jpg",
      "image/jpeg",
    )
    expect(f.results).toEqual([
      {
        ok: true,
        data: {
          requestId: "p1abc",
          key: "photo/p1abc",
          url: "miniapp://com.mentra.camera/.mentra/files/mywpiww0-abc.jpg",
          mimeType: "image/jpeg",
          size: 61234,
          expiresAt: 1_800_000_000_000,
        },
        error: undefined,
      },
    ])
  })

  test("the photo's URL is on the screen's own origin, by the file's name on disk", async () => {
    const f = fixture()
    await f.host.handlePhoto(PACKAGE, {delivery: "local"}, "req-1")
    expect(f.miniappFileUrl).toHaveBeenCalledWith(PACKAGE, "mywpiww0-abc.jpg")
    expect(f.dataUrlOf).not.toHaveBeenCalled()
  })

  test("a screen the app doesn't serve (a development server) gets the photo in a data: URL", async () => {
    const f = fixture({screenOrigin: null})
    await f.host.handlePhoto(PACKAGE, {delivery: "local"}, "req-1")
    expect(f.dataUrlOf).toHaveBeenCalledWith(PACKAGE, "photo/p1abc", 1024 * 1024)
    expect(f.results[0]).toMatchObject({ok: true, data: {key: "photo/p1abc", url: "data:image/jpeg;base64,/9j/"}})
  })

  test("a photo too large for a data: URL has no url there, and still has its key", async () => {
    const f = fixture({screenOrigin: null})
    f.dataUrlOf.mockResolvedValue(null)
    await f.host.handlePhoto(PACKAGE, {delivery: "local"}, "req-1")
    const data = f.results[0]!.data as Record<string, unknown>
    expect(data.key).toBe("photo/p1abc")
    expect("url" in data).toBe(false)
  })

  test("a request that doesn't ask keeps the managed cloud photo", async () => {
    const f = fixture()
    await f.host.handlePhoto(PACKAGE, {size: "low"}, "req-1")
    expect(f.takeLocalPhoto).not.toHaveBeenCalled()
    expect(f.results[0]).toMatchObject({ok: true, data: {photoUrl: "https://r2.test/p.jpg", requestId: "rq-77"}})
  })

  test("a photo that can't be stored fails the request and doesn't stay in the cache folder", async () => {
    const f = fixture({storeFails: true})
    await f.host.handlePhoto(PACKAGE, {delivery: "local"}, "req-1")
    expect(f.discardFile).toHaveBeenCalledWith("file:///cache/mentra_local_photos/photo_1.jpg")
    expect(f.results[0]).toMatchObject({ok: false, error: {code: "PHOTO_STORE_FAILED", stage: "save"}})
  })
})
