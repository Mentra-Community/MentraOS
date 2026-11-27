/// <reference types="bun-types" />

import {describe, expect, mock, test} from "bun:test"
import {readFileSync} from "node:fs"

// Same approach as LocalMiniappRuntime.fleetPhoto.test.ts: run the shipped methods against faked I/O.
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const start = source.search(/^ {2}private async takeLocalPhoto\(/m)
if (start < 0) throw new Error("Missing runtime method takeLocalPhoto")
// Through sendPhotoError: takeLocalPhoto, keepPhotoForMiniapp, handlePhoto, handlePhotoFetch.
const handler = source.indexOf("  private sendPhotoError(", start)
if (handler < 0) throw new Error("Missing runtime method sendPhotoError")
const end = source.slice(handler).search(/^ {2}}$/m)
if (end < 0) throw new Error("Missing end of runtime method sendPhotoError")
const compiled = new Bun.Transpiler({loader: "ts"}).transformSync(
  `class Host { ${source.slice(start, handler + end + 3)} }`,
)

const PACKAGE = "com.mentra.camera"

class PhotoError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly stage?: string,
    readonly transport?: string,
    readonly photoId?: string,
  ) {
    super(message)
  }
}

const THUMBNAIL = {
  fileUri: "file:///cache/mentra_local_photos/photo_1.thumb.jpg",
  width: 512,
  height: 384,
  mimeType: "image/jpeg",
}

function fixture(
  opts: {
    storeFails?: boolean
    thumbnailStoreFails?: boolean
    screenOrigin?: string | null
    photoPauseHeld?: boolean
    thumbnail?: boolean
  } = {},
) {
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
    ...(opts.thumbnail ? {thumbnail: THUMBNAIL} : {}),
  }))
  // The blob store names each file's screen URL, as BlobStore does: null for a package with no screen.
  const origin = opts.screenOrigin === undefined ? "miniapp://com.mentra.camera" : opts.screenOrigin
  const urlOf = (fileName: string) => (origin ? {url: `${origin}/.mentra/files/${fileName}`} : {})
  const storeCachedFile = mock((_pkg: string, key: string, _uri: string, mimeType: string) => {
    const thumbnail = key.endsWith("/thumbnail")
    if (thumbnail ? opts.thumbnailStoreFails : opts.storeFails) throw new Error("disk full")
    const fileName = thumbnail ? "mywpiww1-def.jpg" : "mywpiww0-abc.jpg"
    return {
      key,
      mimeType,
      bytes: thumbnail ? 30000 : 61234,
      cached: true,
      uri: `file:///documents/mentra_blobs/core.mu_1.p/com.mentra.camera/${fileName}`,
      ...urlOf(fileName),
    }
  })
  const released = mock(async () => {})
  const capturePhoto = mock((_pkg: string, _opts: unknown, _photoId?: string) => ({}))
  const capture = mock((_pkg: string, photoId: string) => ({
    photoId,
    captured: Promise.resolve(),
    preview: Promise.resolve({url: "data:image/jpeg;base64,/9j/", width: 500, height: 375}),
    photo: async () => ({
      fileUri: `file:///cache/${photoId}.jpg`,
      mimeType: "image/jpeg",
      size: 61234,
      requestId: photoId,
    }),
    release: released,
  }))
  const discardFile = mock((_uri: string) => {})
  const Host = new Function(
    "phonePhotoCoordinator",
    "fleetEvents",
    "parsePhotoCompression",
    "logPermissionNotDeclared",
    "MiniappRequestType",
    "MiniappErrorCode",
    "PhotoError",
    "acsMeetingService",
    "LOG_TAG",
    `${compiled}; return Host`,
  )(
    {takePhoto, takeLocalPhoto, capturePhoto, capture},
    {photo: () => {}},
    (value: unknown) => value ?? "none",
    () => {},
    {PHOTO: "photo", PHOTO_CAPTURE: "capture", PHOTO_CAPTURE_STAGE: "stage", PHOTO_RELEASE: "release"},
    {PERMISSION_NOT_DECLARED: "PERMISSION_NOT_DECLARED", INTERNAL: "INTERNAL"},
    PhotoError,
    {photoPauseHeld: () => opts.photoPauseHeld === true},
    "LOCAL_MINIAPP",
  )
  const host = new Host()
  const results: Array<{ok: boolean; data?: unknown; error?: {code?: string; stage?: string; photoId?: string}}> = []
  host.connectedApps = new Map([[PACKAGE, {installedManifest: {permissions: [{type: "CAMERA"}]}}]])
  host.blobStore = {storeCachedFile, discardFile}
  host.sendResult = (_pkg: string, _requestId: string | undefined, ok: boolean, data?: unknown, error?: never) => {
    results.push({ok, data, error})
  }
  return {
    host,
    results,
    takePhoto,
    takeLocalPhoto,
    capturePhoto,
    capture,
    released,
    storeCachedFile,
    discardFile,
  }
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

  test("a request for local delivery gets a cached blob, and no cloud photo is requested", async () => {
    const f = fixture()
    await f.host.handlePhoto(PACKAGE, {delivery: "local", size: "low", saveToGallery: true}, "req-1")
    expect(f.takePhoto).not.toHaveBeenCalled()
    expect(f.takeLocalPhoto).toHaveBeenCalledWith(PACKAGE, expect.objectContaining({size: "low", saveToGallery: true}))
    expect(f.storeCachedFile).toHaveBeenCalledWith(
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
        },
        error: undefined,
      },
    ])
  })

  test("the photo's URL is the stored file's, on the screen's own origin", async () => {
    const f = fixture()
    await f.host.handlePhoto(PACKAGE, {delivery: "local"}, "req-1")
    expect(f.results[0]).toMatchObject({
      ok: true,
      data: {url: "miniapp://com.mentra.camera/.mentra/files/mywpiww0-abc.jpg"},
    })
  })

  test("a package with no screen gets no url, and still has its key", async () => {
    const f = fixture({screenOrigin: null})
    await f.host.handlePhoto(PACKAGE, {delivery: "local"}, "req-1")
    const data = f.results[0]!.data as Record<string, unknown>
    expect(data.key).toBe("photo/p1abc")
    expect("url" in data).toBe(false)
  })

  test("the photo's thumbnail is stored with it and handed out beside it", async () => {
    const f = fixture({thumbnail: true})
    await f.host.handlePhoto(PACKAGE, {delivery: "local"}, "req-1")
    expect(f.storeCachedFile).toHaveBeenCalledWith(PACKAGE, "photo/p1abc/thumbnail", THUMBNAIL.fileUri, "image/jpeg")
    // The thumbnail first: the photo, stored last, can't be evicted to make room for its thumbnail.
    expect(f.storeCachedFile.mock.calls.map((call) => call[1])).toEqual(["photo/p1abc/thumbnail", "photo/p1abc"])
    expect(f.results[0]).toMatchObject({
      ok: true,
      data: {
        key: "photo/p1abc",
        thumbnail: {
          key: "photo/p1abc/thumbnail",
          url: "miniapp://com.mentra.camera/.mentra/files/mywpiww1-def.jpg",
          width: 512,
          height: 384,
          mimeType: "image/jpeg",
        },
      },
    })
  })

  test("a photo with no thumbnail has none", async () => {
    const f = fixture()
    await f.host.handlePhoto(PACKAGE, {delivery: "local"}, "req-1")
    expect(f.storeCachedFile).toHaveBeenCalledTimes(1)
    expect("thumbnail" in (f.results[0]!.data as Record<string, unknown>)).toBe(false)
  })

  test("a thumbnail that can't be stored is deleted, and the photo still goes", async () => {
    const f = fixture({thumbnail: true, thumbnailStoreFails: true})
    const warn = mock(() => {})
    const original = console.warn
    console.warn = warn
    try {
      await f.host.handlePhoto(PACKAGE, {delivery: "local"}, "req-1")
    } finally {
      console.warn = original
    }
    expect(f.discardFile).toHaveBeenCalledWith(THUMBNAIL.fileUri)
    expect(f.results[0]).toMatchObject({ok: true, data: {key: "photo/p1abc"}})
    expect("thumbnail" in (f.results[0]!.data as Record<string, unknown>)).toBe(false)
  })

  test("a request that doesn't ask keeps the managed cloud photo", async () => {
    const f = fixture()
    await f.host.handlePhoto(PACKAGE, {size: "low"}, "req-1")
    expect(f.takeLocalPhoto).not.toHaveBeenCalled()
    expect(f.results[0]).toMatchObject({ok: true, data: {photoUrl: "https://r2.test/p.jpg", requestId: "rq-77"}})
  })

  test("a photo that can't be stored fails the request and doesn't stay in the cache folder", async () => {
    const f = fixture({storeFails: true, thumbnail: true})
    await f.host.handlePhoto(PACKAGE, {delivery: "local"}, "req-1")
    expect(f.discardFile).toHaveBeenCalledWith("file:///cache/mentra_local_photos/photo_1.jpg")
    expect(f.discardFile).toHaveBeenCalledWith(THUMBNAIL.fileUri)
    expect(f.results[0]).toMatchObject({ok: false, error: {code: "PHOTO_STORE_FAILED", stage: "save"}})
  })
})

describe("camera.capture()", () => {
  test("starts a capture under its photo ID, answers its stages, and keeps the photo as takePhoto's", async () => {
    const f = fixture()
    await f.host.handlePhotoCapture(PACKAGE, "capture", {photoId: "p9", size: "high", preview: true}, "req-1")
    expect(f.capturePhoto).toHaveBeenCalledWith(PACKAGE, expect.objectContaining({size: "high", preview: true}), "p9")
    await f.host.handlePhotoCapture(PACKAGE, "stage", {photoId: "p9", stage: "preview"}, "req-2")
    await f.host.handlePhotoCapture(PACKAGE, "stage", {photoId: "p9", stage: "photo"}, "req-3")
    await f.host.handlePhotoCapture(PACKAGE, "release", {photoId: "p9"}, "req-4")
    expect(f.capture).toHaveBeenCalledWith(PACKAGE, "p9")
    expect(f.storeCachedFile).toHaveBeenCalledWith(PACKAGE, "photo/p9", "file:///cache/p9.jpg", "image/jpeg")
    expect(f.results).toMatchObject([
      {ok: true},
      {ok: true, data: {url: "data:image/jpeg;base64,/9j/", width: 500}},
      {ok: true, data: {requestId: "p9", key: "photo/p9"}},
      {ok: true},
    ])
    expect(f.released).toHaveBeenCalled()
  })

  test("an unknown or released capture is an error for the miniapp", async () => {
    const f = fixture()
    f.capture.mockImplementation(() => {
      throw new PhotoError("PHOTO_RELEASED", "No photo p0 for this miniapp", "command")
    })
    await f.host.handlePhotoCapture(PACKAGE, "stage", {photoId: "p0", stage: "photo"}, "req-1")
    expect(f.results[0]).toMatchObject({ok: false, error: {code: "PHOTO_RELEASED"}})
  })
})
