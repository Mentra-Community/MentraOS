/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {MiniappRequestType} from "../protocol"
import type {MiniappSession} from "../session"
import {StreamModule, type StreamResult} from "./stream"

function mockSession<T>(result: T) {
  const requestCalls: object[] = []
  const session = {
    sendOneShot: () => {
      throw new Error("stream starts should use sendRequest")
    },
    sendRequest: (payload: object) => {
      requestCalls.push(payload)
      return Promise.resolve(result)
    },
  } as unknown as MiniappSession

  return {session, requestCalls}
}

describe("StreamModule", () => {
  test("startStream defaults to a managed stream and returns playback URLs", async () => {
    const result: StreamResult = {
      streamId: "phone-m-1",
      status: "streaming",
      liveInputId: "cf-input",
      hlsUrl: "https://playback.example.test/manifest/video.m3u8",
      dashUrl: "https://playback.example.test/manifest/video.mpd",
      webrtcUrl: "https://playback.example.test/whep",
      resolvedConfig: {
        transport: "whip",
        audio: {sampleRate: 48_000},
      },
    }
    const {session, requestCalls} = mockSession(result)
    const stream = new StreamModule(session)

    await expect(
      stream.startStream({
        destinations: [{url: "rtmp://dest.example/live/key", name: "demo"}],
        video: {fps: 24},
        audio: {sampleRate: 48_000},
      }),
    ).resolves.toEqual(result)
    expect(requestCalls).toEqual([
      {
        type: MiniappRequestType.MANAGED_STREAM_START,
        restreamDestinations: [{url: "rtmp://dest.example/live/key", name: "demo"}],
        video: {fps: 24},
        audio: {sampleRate: 48_000},
        sound: true,
        ingest: undefined,
      },
    ])
  })

  test("startStream({direct}) publishes straight to the given URL", async () => {
    const result: StreamResult = {
      streamId: "phone-d-1",
      status: "streaming",
      resolvedConfig: {
        transport: "rtmp",
        video: {width: 1280, height: 720, bitrate: 2_500_000, fps: 30},
      },
    }
    const {session, requestCalls} = mockSession(result)
    const stream = new StreamModule(session)

    await expect(
      stream.startStream({
        direct: "rtmp://example.test/live/key",
        sound: false,
        video: {fps: 30},
      }),
    ).resolves.toEqual(result)
    expect(requestCalls).toEqual([
      {
        type: MiniappRequestType.STREAM_START,
        streamUrl: "rtmp://example.test/live/key",
        video: {fps: 30},
        audio: undefined,
        sound: false,
      },
    ])
  })

  test("stop forwards an optional streamId", async () => {
    const {session, requestCalls} = mockSession(undefined)
    const stream = new StreamModule(session)

    await stream.stop("phone-m-1")
    expect(requestCalls).toEqual([{type: MiniappRequestType.STREAM_STOP, streamId: "phone-m-1"}])
  })
})
