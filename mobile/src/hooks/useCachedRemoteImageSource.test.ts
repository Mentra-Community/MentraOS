/**
 * Regression coverage for the dev-miniapp icon load path.
 *
 * `mentra dev`'s static server serves the tile icon with `Cache-Control:
 * no-store`, so expo-image downloads it (prefetch → true) but never persists it
 * to disk — `getCachePathAsync` stays null. The hook must NOT treat that as a
 * failure; it should fall back to the original URL (warm in expo-image's memory
 * cache) so the real logo renders instead of the placeholder.
 */

const mockPrefetch = jest.fn<Promise<boolean>, [string, unknown?]>()
const mockGetCachePathAsync = jest.fn<Promise<string | null>, [string]>()

jest.mock("expo-image", () => ({
  Image: {
    prefetch: (url: string, opts?: unknown) => mockPrefetch(url, opts),
    getCachePathAsync: (url: string) => mockGetCachePathAsync(url),
  },
}))

import {
  warmCachedRemoteImageSources,
  isCachedRemoteImageResolved,
  isRemoteImageSourceFailed,
} from "./useCachedRemoteImageSource"

beforeEach(() => {
  mockPrefetch.mockReset()
  mockGetCachePathAsync.mockReset()
})

describe("useCachedRemoteImageSource cache resolution", () => {
  it("resolves a normal (disk-cacheable) remote icon to its file:// path", async () => {
    const url = "https://cdn.example.com/store-icon-a.png"
    mockGetCachePathAsync.mockResolvedValue("/tmp/cache/store-icon-a.png")

    await warmCachedRemoteImageSources([url])

    expect(isCachedRemoteImageResolved(url)).toBe(true)
    expect(isRemoteImageSourceFailed(url)).toBe(false)
    // Disk path was available up front — no prefetch needed.
    expect(mockPrefetch).not.toHaveBeenCalled()
  })

  it("falls back to the original URL when prefetch succeeds but the icon isn't disk-cached (no-store dev server)", async () => {
    const url = "http://192.168.1.50:3000/icon.png"
    // No disk path ever (server sent Cache-Control: no-store), but the bytes
    // download fine so prefetch reports success.
    mockGetCachePathAsync.mockResolvedValue(null)
    mockPrefetch.mockResolvedValue(true)

    await warmCachedRemoteImageSources([url])

    // Resolved (so the grid reveals + the tile shows the real icon), NOT failed.
    expect(isCachedRemoteImageResolved(url)).toBe(true)
    expect(isRemoteImageSourceFailed(url)).toBe(false)
    expect(mockPrefetch).toHaveBeenCalledWith(url, expect.objectContaining({cachePolicy: "memory-disk"}))
  })

  it("marks the icon failed when the prefetch itself fails (unreachable dev server)", async () => {
    const url = "http://192.168.1.50:3000/gone.png"
    mockGetCachePathAsync.mockResolvedValue(null)
    mockPrefetch.mockResolvedValue(false)

    await warmCachedRemoteImageSources([url])

    expect(isCachedRemoteImageResolved(url)).toBe(false)
    expect(isRemoteImageSourceFailed(url)).toBe(true)
  })
})
