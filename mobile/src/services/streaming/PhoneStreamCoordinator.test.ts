/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"

// Mock module dependencies BEFORE importing the coordinator.
const startStream = mock(async (_req: unknown) => {})
const stopStream = mock(async () => {})
const keepStreamAlive = mock(async (_req: unknown) => {})

mock.module("@mentra/bluetooth-sdk", () => ({
  default: {startStream, stopStream, keepStreamAlive},
}))

const provisionManagedStream = mock(async (_destinations?: unknown) => ({
  liveInputId: "cf-input-test",
  rtmpUrl: "rtmp://ingest.test/abc",
  srtUrl: "srt://ingest.test/abc",
  hlsUrl: "https://playback.test/abc/manifest/video.m3u8",
  dashUrl: "https://playback.test/abc/manifest/video.mpd",
  webrtcUrl: "https://playback.test/abc/whep",
  webrtcPublishUrl: "https://ingest.test/abc/whip",
  outputs: [],
}))
const getManagedStreamStatus = mock(async (_id: string) => ({
  isConnected: true,
  viewerCount: 0,
}))
const teardownManagedStream = mock(async (_id: string) => {})

mock.module("./v2StreamApi", () => ({
  provisionManagedStream,
  getManagedStreamStatus,
  teardownManagedStream,
}))

// Patch global fetch so the HLS readiness HEAD probe is deterministic.
let hlsHeadResponder: () => Response = () => new Response(null, {status: 200})
const realFetch = globalThis.fetch
beforeEach(() => {
  startStream.mockClear()
  stopStream.mockClear()
  keepStreamAlive.mockClear()
  provisionManagedStream.mockClear()
  getManagedStreamStatus.mockClear()
  teardownManagedStream.mockClear()
  hlsHeadResponder = () => new Response(null, {status: 200})
  ;(globalThis as {fetch: typeof fetch}).fetch = async (url) => {
    if (typeof url === "string" && url.includes("manifest/video.m3u8")) {
      return hlsHeadResponder()
    }
    return realFetch(url as string)
  }
})
afterEach(() => {
  ;(globalThis as {fetch: typeof fetch}).fetch = realFetch
})

const {PhoneStreamCoordinator, StreamConflictError} = await import("./PhoneStreamCoordinator")

describe("PhoneStreamCoordinator", () => {
  describe("unmanaged", () => {
    test("startUnmanaged commands glasses and returns a phone-minted streamId", async () => {
      const coord = new PhoneStreamCoordinator({
        hlsReadinessInitialDelayMs: 5,
        hlsReadinessPollMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })
      const {streamId} = await coord.startUnmanaged("com.a", {
        streamUrl: "rtmp://my.server/key",
      })
      expect(streamId).toMatch(/^phone-u-/)
      expect(startStream).toHaveBeenCalledTimes(1)
      const arg = startStream.mock.calls[0]![0] as {streamUrl: string; streamId: string}
      expect(arg.streamUrl).toBe("rtmp://my.server/key")
      expect(arg.streamId).toBe(streamId)
      expect(coord.owns(streamId)).toBe(true)
    })

    test("startUnmanaged rejects when another stream is active", async () => {
      const coord = new PhoneStreamCoordinator({
        hlsReadinessInitialDelayMs: 5,
        hlsReadinessPollMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })
      await coord.startUnmanaged("com.a", {streamUrl: "rtmp://x"})
      await expect(
        coord.startUnmanaged("com.b", {streamUrl: "rtmp://y"}),
      ).rejects.toBeInstanceOf(StreamConflictError)
    })

    test("stop tears down the stream and reverses owns()", async () => {
      const coord = new PhoneStreamCoordinator({
        hlsReadinessInitialDelayMs: 5,
        hlsReadinessPollMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })
      const {streamId} = await coord.startUnmanaged("com.a", {streamUrl: "rtmp://x"})
      await coord.stop("com.a", streamId)
      expect(stopStream).toHaveBeenCalled()
      expect(coord.owns(streamId)).toBe(false)
    })

    test("stop is a no-op for a non-owning package", async () => {
      const coord = new PhoneStreamCoordinator({
        hlsReadinessInitialDelayMs: 5,
        hlsReadinessPollMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })
      const {streamId} = await coord.startUnmanaged("com.a", {streamUrl: "rtmp://x"})
      await coord.stop("com.b")
      expect(stopStream).not.toHaveBeenCalled()
      expect(coord.owns(streamId)).toBe(true)
    })

    test("stop rolls back state if CoreModule.startStream rejects", async () => {
      startStream.mockRejectedValueOnce(new Error("BLE down"))
      const coord = new PhoneStreamCoordinator({
        hlsReadinessInitialDelayMs: 5,
        hlsReadinessPollMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })
      await expect(coord.startUnmanaged("com.a", {streamUrl: "rtmp://x"})).rejects.toThrow(
        "BLE down",
      )
      // Should be able to start another stream after the failure.
      await coord.startUnmanaged("com.a", {streamUrl: "rtmp://y"})
      expect(startStream).toHaveBeenCalledTimes(2)
    })
  })

  describe("managed", () => {
    test("startManaged provisions Cloudflare and resolves when HLS is ready", async () => {
      const coord = new PhoneStreamCoordinator({
        hlsReadinessInitialDelayMs: 5,
        hlsReadinessPollMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })
      const result = await coord.startManaged("com.a", {})
      expect(result.streamId).toMatch(/^phone-m-/)
      expect(result.liveInputId).toBe("cf-input-test")
      expect(result.hlsUrl).toBe("https://playback.test/abc/manifest/video.m3u8")
      expect(result.webrtcUrl).toBe("https://playback.test/abc/whep")
      expect(provisionManagedStream).toHaveBeenCalledTimes(1)
      // Glasses should be told to publish to the WHIP endpoint (preferred).
      const arg = startStream.mock.calls[0]![0] as {streamUrl: string}
      expect(arg.streamUrl).toBe("https://ingest.test/abc/whip")
    })

    test("second miniapp joins existing managed stream and gets same URLs", async () => {
      const coord = new PhoneStreamCoordinator({
        hlsReadinessInitialDelayMs: 5,
        hlsReadinessPollMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })
      const a = await coord.startManaged("com.a", {})
      const b = await coord.startManaged("com.b", {})
      expect(b.streamId).toBe(a.streamId)
      expect(b.hlsUrl).toBe(a.hlsUrl)
      // Provision called exactly ONCE; second join was a refcount add.
      expect(provisionManagedStream).toHaveBeenCalledTimes(1)
    })

    test("second miniapp passing restream destinations is rejected", async () => {
      const coord = new PhoneStreamCoordinator({
        hlsReadinessInitialDelayMs: 5,
        hlsReadinessPollMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })
      await coord.startManaged("com.a", {})
      await expect(
        coord.startManaged("com.b", {
          restreamDestinations: [{url: "rtmp://yt", streamKey: "yt"}],
        }),
      ).rejects.toBeInstanceOf(StreamConflictError)
    })

    test("multi-subscriber: stop from one keeps stream alive; last stop tears down", async () => {
      const coord = new PhoneStreamCoordinator({
        hlsReadinessInitialDelayMs: 5,
        hlsReadinessPollMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })
      const a = await coord.startManaged("com.a", {})
      await coord.startManaged("com.b", {})
      await coord.stop("com.a")
      expect(teardownManagedStream).not.toHaveBeenCalled()
      expect(stopStream).not.toHaveBeenCalled()
      await coord.stop("com.b", a.streamId)
      expect(teardownManagedStream).toHaveBeenCalledWith("cf-input-test")
      expect(stopStream).toHaveBeenCalled()
    })

    test("managed cannot start while unmanaged is active", async () => {
      const coord = new PhoneStreamCoordinator({
        hlsReadinessInitialDelayMs: 5,
        hlsReadinessPollMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })
      await coord.startUnmanaged("com.a", {streamUrl: "rtmp://x"})
      await expect(coord.startManaged("com.b", {})).rejects.toBeInstanceOf(StreamConflictError)
    })

    test("provision failure surfaces to caller and leaves coordinator clean", async () => {
      provisionManagedStream.mockRejectedValueOnce(new Error("cf 502"))
      const coord = new PhoneStreamCoordinator({
        hlsReadinessInitialDelayMs: 5,
        hlsReadinessPollMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })
      await expect(coord.startManaged("com.a", {})).rejects.toThrow("cf 502")
      // Coordinator should be ready to accept a new stream.
      const {streamId} = await coord.startUnmanaged("com.a", {streamUrl: "rtmp://x"})
      expect(coord.owns(streamId)).toBe(true)
    })
  })

  describe("status routing", () => {
    test("fanout delivers status to all subscribers of a managed stream", async () => {
      const coord = new PhoneStreamCoordinator({
        hlsReadinessInitialDelayMs: 5,
        hlsReadinessPollMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })
      const updates: Array<{pkg: string; status: string}> = []
      coord.setStatusSubscriber((pkg, update) => updates.push({pkg, status: update.status}))
      const result = await coord.startManaged("com.a", {})
      await coord.startManaged("com.b", {})
      coord.handleGlassesStatus({
        type: "stream_status",
        kind: "lifecycle",
        status: "streaming",
        streamId: result.streamId,
      } as never)
      const streaming = updates.filter((u) => u.status === "streaming")
      expect(streaming.map((u) => u.pkg).sort()).toEqual(["com.a", "com.b"])
    })

    test("glasses error status triggers teardown", async () => {
      const coord = new PhoneStreamCoordinator({
        hlsReadinessInitialDelayMs: 5,
        hlsReadinessPollMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })
      const {streamId} = await coord.startUnmanaged("com.a", {streamUrl: "rtmp://x"})
      coord.handleGlassesStatus({
        type: "stream_status",
        kind: "error",
        status: "error",
        streamId,
        errorDetails: "publisher exploded",
      } as never)
      // Teardown is async; let it settle.
      await new Promise((r) => setTimeout(r, 5))
      expect(stopStream).toHaveBeenCalled()
      expect(coord.owns(streamId)).toBe(false)
    })
  })
})
