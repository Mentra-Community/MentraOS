/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

let hold: {binding: {gateway: string}; release: ReturnType<typeof mock>} | null = null
const holdGlassesWifiIfUp = mock(async (_consumer: string) => hold)
mock.module("../GlassesWifi", () => ({holdGlassesWifiIfUp}))

let statusCode = 200
const downloads: Array<{fromUrl: string; toFile: string}> = []
mock.module("../asg/localNetworkTransport", () => ({
  localNetworkTransport: {
    downloadFile: (options: {fromUrl: string; toFile: string}) => {
      downloads.push(options)
      return {jobId: 1, promise: Promise.resolve({statusCode})}
    },
  },
}))
mock.module("expo-file-system", () => ({
  Paths: {cache: "file:///cache"},
  File: class {
    uri: string
    exists = true
    constructor(dir: string, name: string) {
      this.uri = `${dir}/${name}`
    }
    delete() {}
  },
}))

const {fetchGlassesFile} = await import("../GlassesFiles")

describe("fetchGlassesFile", () => {
  beforeEach(() => {
    hold = null
    statusCode = 200
    downloads.length = 0
  })

  test("goes over Bluetooth when no glasses Wi-Fi link is up, without bringing one up", async () => {
    const overBluetooth = mock(async () => "file:///cache/ble.jpg")
    expect(await fetchGlassesFile("p9", overBluetooth)).toBe("file:///cache/ble.jpg")
    expect(downloads).toEqual([])
  })

  test("holds the link that is up for the fetch, from the glasses' file server", async () => {
    hold = {binding: {gateway: "192.168.43.1"}, release: mock(async () => {})}
    const overBluetooth = mock(async () => "file:///cache/ble.jpg")
    expect(await fetchGlassesFile("p9", overBluetooth)).toBe("file:///cache/glasses-file-p9")
    expect(downloads[0]!.fromUrl).toBe("http://192.168.43.1:8089/api/deferred?id=p9")
    expect(overBluetooth).not.toHaveBeenCalled()
    expect(hold.release).toHaveBeenCalledTimes(1)
  })

  test("falls back to Bluetooth when the glasses don't serve it, and still gives the link back", async () => {
    hold = {binding: {gateway: "192.168.43.1"}, release: mock(async () => {})}
    statusCode = 404
    expect(await fetchGlassesFile("p9", async () => "file:///cache/ble.jpg")).toBe("file:///cache/ble.jpg")
    expect(hold.release).toHaveBeenCalledTimes(1)
  })
})
