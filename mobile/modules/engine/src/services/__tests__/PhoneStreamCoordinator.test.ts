/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"

// Mock module dependencies BEFORE importing the coordinator.
const startStream = mock(async (_req: unknown) => {})
const streamStatusFor = (req: unknown) => ({
  type: "stream_status",
  kind: "lifecycle",
  status: "streaming",
  streamId: (req as {streamId?: string}).streamId,
  resolvedConfig: {audio: {sampleRate: 16_000}},
})
const startExternallyManagedStream = mock(async (req: unknown) => streamStatusFor(req))
const stopStream = mock(async () => {})
const sendExternallyManagedStreamKeepAlive = mock(async (_req: unknown) => {})

mock.module("@mentra/bluetooth-sdk/internal", () => ({
  default: {startStream, startExternallyManagedStream, stopStream, sendExternallyManagedStreamKeepAlive},
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

mock.module("../cloudStreamApi", () => ({
  provisionManagedStream,
  getManagedStreamStatus,
  teardownManagedStream,
}))

// The coordinator's glasses-connected precheck reads the engine glasses store via
// isGlassesConnected. Mock both (the real store transitively drags react-native,
// which bun can't parse) so the precheck passes deterministically.
mock.module("../../stores/glasses", () => ({
  useGlassesStore: {getState: () => ({connection: {state: "connected"}})},
}))
mock.module("../GlassesReadiness", () => ({
  isGlassesConnected: () => true,
}))


// Patch global fetch so the HLS readiness HEAD probe is deterministic.
let hlsHeadResponder: () => Response = () => new Response(null, {status: 200})
const realFetch = globalThis.fetch
beforeEach(() => {
  startStream.mockClear()
  startExternallyManagedStream.mockClear()
  stopStream.mockClear()
  sendExternallyManagedStreamKeepAlive.mockClear()
  provisionManagedStream.mockClear()
  getManagedStreamStatus.mockClear()
  getManagedStreamStatus.mockImplementation(async (_id: string) => ({
    isConnected: true,
    viewerCount: 0,
  }))
  teardownManagedStream.mockClear()
  hlsHeadResponder = () => new Response(null, {status: 200})
  ;(globalThis as {fetch: typeof fetch}).fetch = (async (url) => {
    if (typeof url === "string" && url.includes("manifest/video.m3u8")) {
      return hlsHeadResponder()
    }
    return realFetch(url as string)
  }) as typeof fetch
})
afterEach(() => {
  ;(globalThis as {fetch: typeof fetch}).fetch = realFetch
})

const {PhoneStreamCoordinator, StreamConflictError} = await import("../PhoneStreamCoordinator")

describe("PhoneStreamCoordinator", () => {
  describe("unmanaged", () => {
    test("startUnmanaged commands glasses and returns a phone-minted streamId", async () => {
      const coord = new PhoneStreamCoordinator({
        hlsReadinessInitialDelayMs: 5,
        hlsReadinessPollMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })
      const result = await coord.startUnmanaged("com.a", {
        streamUrl: "rtmp://my.server/key",
        sound: false,
      })
      const {streamId} = result
      expect(streamId).toMatch(/^phone-u-/)
      expect(result.status).toBe("streaming")
      expect(result.resolvedConfig).toEqual({audio: {sampleRate: 16_000}})
      expect(startExternallyManagedStream).toHaveBeenCalledTimes(1)
      const arg = startExternallyManagedStream.mock.calls[0]![0] as {
        sound: boolean
        streamUrl: string
        streamId: string
      }
      expect(arg.streamUrl).toBe("rtmp://my.server/key")
      expect(arg.streamId).toBe(streamId)
      expect(arg.sound).toBe(false)
      expect("keepAlive" in arg).toBe(false)
      expect("keepAliveIntervalSeconds" in arg).toBe(false)
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

    test("start rolls back state if BluetoothSdk.startExternallyManagedStream rejects", async () => {
      startExternallyManagedStream.mockRejectedValueOnce(new Error("BLE down"))
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
      expect(startExternallyManagedStream).toHaveBeenCalledTimes(2)
    })
  })

  describe("managed", () => {
    test("WHIP probes Cloudflare immediately and retries quickly during startup", async () => {
      getManagedStreamStatus
        .mockImplementationOnce(async () => ({isConnected: false, viewerCount: 0}))
        .mockImplementationOnce(async () => ({isConnected: true, viewerCount: 0}))

      const coord = new PhoneStreamCoordinator({
        cloudflareStartupPollInitialMs: 5,
        cloudflareStatusPollMs: 1000,
        hlsReadinessPollMs: 1000,
        hlsReadinessMaxAttempts: 5,
        keepAliveIntervalMs: 10_000,
      })
      const result = await coord.startManaged("com.a", {ingest: "whip"})

      expect(result.mode).toBe("webrtc")
      expect(result.webrtcUrl).toBe("https://playback.test/abc/whep")
      expect(getManagedStreamStatus).toHaveBeenCalledTimes(2)
      await coord.stop("com.a")
    })

    test("WHIP startup resolves when the immediate probe is already connected", async () => {
      const coord = new PhoneStreamCoordinator({
        cloudflareStartupPollInitialMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })

      const result = await coord.startManaged("com.a", {ingest: "whip"})

      expect(result.mode).toBe("webrtc")
      expect(getManagedStreamStatus).toHaveBeenCalledTimes(1)
      await coord.stop("com.a")
    })

    test("WHIP startup rejects when Cloudflare never reports the publisher", async () => {
      getManagedStreamStatus.mockImplementation(async () => ({isConnected: false, viewerCount: 0}))
      const coord = new PhoneStreamCoordinator({
        cloudflareStartupPollInitialMs: 1,
        cloudflareStatusPollMs: 5,
        hlsReadinessPollMs: 5,
        hlsReadinessMaxAttempts: 1,
        keepAliveIntervalMs: 10_000,
      })

      await expect(coord.startManaged("com.a", {ingest: "whip"})).rejects.toThrow(
        "WebRTC ingest never reached Cloudflare",
      )
    })

    test("startManaged provisions Cloudflare and resolves when HLS is ready", async () => {
      const coord = new PhoneStreamCoordinator({
        hlsReadinessInitialDelayMs: 5,
        hlsReadinessPollMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })
      const result = await coord.startManaged("com.a", {
        audio: {bitrate: 64_000},
        sound: false,
        video: {fps: 30},
      })
      expect(result.streamId).toMatch(/^phone-m-/)
      expect(result.status).toBe("streaming")
      expect(result.resolvedConfig).toEqual({audio: {sampleRate: 16_000}})
      expect(result.liveInputId).toBe("cf-input-test")
      expect(result.hlsUrl).toBe("https://playback.test/abc/manifest/video.m3u8")
      expect(result.webrtcUrl).toBe("https://playback.test/abc/whep")
      expect(provisionManagedStream).toHaveBeenCalledTimes(1)
      const arg = startExternallyManagedStream.mock.calls[0]![0] as {
        audio: unknown
        sound: boolean
        streamUrl: string
        video: unknown
      }
      // SRT preferred over WHIP/RTMP: Cloudflare's WebRTC ingest doesn't feed
      // HLS playback or recording, and SRT survives RTMPS-hostile firewalls.
      expect(arg.streamUrl).toBe("srt://ingest.test/abc")
      expect(arg.sound).toBe(false)
      expect(arg.video).toEqual({fps: 30})
      expect(arg.audio).toEqual({bitrate: 64_000})
      expect("keepAlive" in arg).toBe(false)
      expect("keepAliveIntervalSeconds" in arg).toBe(false)
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
          restreamDestinations: [{url: "rtmp://yt/STREAM-KEY", name: "YT"}],
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

    test("fanout preserves live bitrate and temperature telemetry", async () => {
      const coord = new PhoneStreamCoordinator({
        hlsReadinessInitialDelayMs: 5,
        hlsReadinessPollMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })
      let telemetry: Record<string, unknown> | undefined
      coord.setStatusSubscriber((_pkg, update) => {
        if (update.status === "streaming") telemetry = update.data
      })
      const {streamId} = await coord.startUnmanaged("com.a", {streamUrl: "rtmp://x"})

      coord.handleGlassesStatus({
        type: "stream_status",
        kind: "lifecycle",
        status: "streaming",
        streamId,
        stats: {bitrate: 912_345, fps: 19.8, duration: 31, temperatureC: 54.6},
      } as never)

      expect(telemetry?.stats).toEqual({
        bitrate: 912_345,
        fps: 19.8,
        duration: 31,
        temperatureC: 54.6,
      })
      await coord.stop("com.a")
    })

    test("glasses transient error does NOT tear down (publisher auto-recovers)", async () => {
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
        errorDetails: "publisher hiccuped",
      } as never)
      await new Promise((r) => setTimeout(r, 5))
      // The glasses publisher retries after errors (error -> reconnecting ->
      // reconnected); tearing down here would delete the live input out from
      // under a publisher that comes right back.
      expect(coord.owns(streamId)).toBe(true)
      await coord.stop("com.a")
    })

    test("glasses reconnect_failed (gave up) triggers teardown", async () => {
      const coord = new PhoneStreamCoordinator({
        hlsReadinessInitialDelayMs: 5,
        hlsReadinessPollMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })
      const {streamId} = await coord.startUnmanaged("com.a", {streamUrl: "rtmp://x"})
      coord.handleGlassesStatus({
        type: "stream_status",
        kind: "reconnect",
        status: "reconnect_failed",
        streamId,
        maxAttempts: 10,
      } as never)
      // Teardown is async; let it settle.
      await new Promise((r) => setTimeout(r, 5))
      expect(stopStream).not.toHaveBeenCalled()
      expect(coord.owns(streamId)).toBe(false)
    })
  })

  describe("concurrency / transition lock", () => {
    test("two concurrent startManaged calls only provision once and share URLs", async () => {
      // Make the underlying provision slow so the two callers genuinely
      // overlap (without the lock, both would pass the precheck).
      provisionManagedStream.mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 30))
        return {
          liveInputId: "cf-input-test",
          rtmpUrl: "rtmp://ingest.test/abc",
          srtUrl: "srt://ingest.test/abc",
          hlsUrl: "https://playback.test/abc/manifest/video.m3u8",
          dashUrl: "https://playback.test/abc/manifest/video.mpd",
          webrtcUrl: "https://playback.test/abc/whep",
          webrtcPublishUrl: "https://ingest.test/abc/whip",
          outputs: [],
        }
      })
      const coord = new PhoneStreamCoordinator({
        hlsReadinessInitialDelayMs: 5,
        hlsReadinessPollMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })
      const [a, b] = await Promise.all([
        coord.startManaged("com.a", {}),
        coord.startManaged("com.b", {}),
      ])
      expect(a.streamId).toBe(b.streamId)
      expect(provisionManagedStream).toHaveBeenCalledTimes(1)
      expect(startExternallyManagedStream).toHaveBeenCalledTimes(1)
    })

    test("concurrent startUnmanaged calls — second rejects, first wins", async () => {
      // Slow the first BLE start so the two callers overlap.
      startExternallyManagedStream.mockImplementationOnce(async (req: unknown) => {
        await new Promise((r) => setTimeout(r, 30))
        return streamStatusFor(req)
      })
      const coord = new PhoneStreamCoordinator({
        hlsReadinessInitialDelayMs: 5,
        hlsReadinessPollMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })
      const results = await Promise.allSettled([
        coord.startUnmanaged("com.a", {streamUrl: "rtmp://a"}),
        coord.startUnmanaged("com.b", {streamUrl: "rtmp://b"}),
      ])
      const fulfilled = results.filter((r) => r.status === "fulfilled")
      const rejected = results.filter((r) => r.status === "rejected")
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StreamConflictError)
      expect(startExternallyManagedStream).toHaveBeenCalledTimes(1)
    })

    test("stop waits for an in-flight start to finish before calling stopStream", async () => {
      // Slow the BLE start; the stop should queue behind it.
      const order: string[] = []
      startExternallyManagedStream.mockImplementationOnce(async (req: unknown) => {
        order.push("start-begin")
        await new Promise((r) => setTimeout(r, 30))
        order.push("start-end")
        return streamStatusFor(req)
      })
      stopStream.mockImplementationOnce(async () => {
        order.push("stop")
      })
      const coord = new PhoneStreamCoordinator({
        hlsReadinessInitialDelayMs: 5,
        hlsReadinessPollMs: 5,
        cloudflareStatusPollMs: 1000,
        keepAliveIntervalMs: 10_000,
      })
      const startP = coord.startUnmanaged("com.a", {streamUrl: "rtmp://x"})
      // Fire stop before start has resolved. Without the lock, stop would
      // immediately call BluetoothSdk.stopStream and clear `current`, racing
      // with the still-in-flight start.
      const stopP = coord.stop("com.a")
      await Promise.all([startP, stopP])
      expect(order).toEqual(["start-begin", "start-end", "stop"])
    })
  })
})
