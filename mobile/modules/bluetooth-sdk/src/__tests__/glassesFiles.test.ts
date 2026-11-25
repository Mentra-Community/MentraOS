import {beforeEach, describe, expect, it, jest} from "@jest/globals"

// The glasses Wi-Fi service and its link, faked: a link is up or not, and the glasses answer.
const mockState = {up: false, released: 0, statusCode: 200, downloads: [] as string[]}
jest.mock("../glasses-wifi/service", () => ({
  holdGlassesWifiIfUp: async () =>
    mockState.up
      ? {
          binding: {ssid: "glasses", password: "", gateway: "192.168.43.1"},
          release: async () => {
            mockState.released++
          },
        }
      : null,
}))
jest.mock("../glasses-wifi/native", () => ({
  downloadToCache: async (url: string, fileName: string) => {
    mockState.downloads.push(url)
    return {statusCode: mockState.statusCode, uri: `file:///cache/${fileName}`, bytes: 123_456}
  },
}))

const {fetchGlassesFileOverWifi} = jest.requireActual<typeof import("../glasses-wifi/files")>("../glasses-wifi/files")

describe("a glasses file over Wi-Fi", () => {
  beforeEach(() => {
    Object.assign(mockState, {up: false, released: 0, statusCode: 200, downloads: []})
  })

  it("is not fetched when no link is up, and no link is brought up for it", async () => {
    await expect(fetchGlassesFileOverWifi("p1")).resolves.toBeNull()
    expect(mockState.downloads).toEqual([])
  })

  it("comes from the glasses' file server while the link is held for the fetch", async () => {
    mockState.up = true
    await expect(fetchGlassesFileOverWifi("p1")).resolves.toEqual({
      uri: "file:///cache/glasses-file-p1",
      bytes: 123_456,
    })
    expect(mockState.downloads).toEqual(["http://192.168.43.1:8089/api/deferred?id=p1"])
    expect(mockState.released).toBe(1)
  })

  it("is null when the glasses don't serve it, and the link is still given back", async () => {
    mockState.up = true
    mockState.statusCode = 404
    await expect(fetchGlassesFileOverWifi("p1")).resolves.toBeNull()
    expect(mockState.released).toBe(1)
  })
})
