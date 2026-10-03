const {streamRequestParamsForNative} = require("../_private/streamRequestPayload")

const baseParams = {
  streamUrl: "http://192.168.1.42:8889/mentra-live/whip",
  streamId: "stream-1",
  sound: true,
}

describe("streamRequestParamsForNative", () => {
  it("preserves omission of telemetry when omitted so glasses use build default", () => {
    const payload = streamRequestParamsForNative(baseParams)
    expect(payload).not.toHaveProperty("telemetry")
    expect("telemetry" in payload).toBe(false)
  })

  it("preserves omission of telemetry when explicitly undefined", () => {
    const payload = streamRequestParamsForNative({
      ...baseParams,
      telemetry: undefined,
    })
    expect(payload).not.toHaveProperty("telemetry")
    expect("telemetry" in payload).toBe(false)
  })

  it("forwards explicit true for telemetry", () => {
    const payload = streamRequestParamsForNative({
      ...baseParams,
      telemetry: true,
    })
    expect(payload).toHaveProperty("telemetry", true)
    expect(payload.telemetry).toBe(true)
  })

  it("forwards explicit false for telemetry", () => {
    const payload = streamRequestParamsForNative({
      ...baseParams,
      telemetry: false,
    })
    expect(payload).toHaveProperty("telemetry", false)
    expect(payload.telemetry).toBe(false)
  })

  it("forwards full stream request configuration with telemetry", () => {
    const payload = streamRequestParamsForNative({
      type: "start_stream",
      streamUrl: "https://example.com/whip",
      streamId: "stream-custom-id",
      sound: false,
      video: {fps: 15, width: 1280, height: 720, bitrate: 2_000_000},
      audio: {sampleRate: 48000, bitrate: 64000, echoCancellation: true},
      authToken: "secret-bearer-token",
      telemetry: true,
    })

    expect(payload).toEqual({
      type: "start_stream",
      streamUrl: "https://example.com/whip",
      streamId: "stream-custom-id",
      sound: false,
      video: {fps: 15, width: 1280, height: 720, bitrate: 2_000_000},
      audio: {sampleRate: 48000, bitrate: 64000, echoCancellation: true},
      authToken: "secret-bearer-token",
      telemetry: true,
    })
  })

  it("does not include undefined optional fields in native payload", () => {
    const payload = streamRequestParamsForNative({
      streamUrl: "https://example.com/whip",
      streamId: undefined,
      sound: undefined,
      video: undefined,
      audio: undefined,
      authToken: undefined,
      telemetry: undefined,
    })

    expect(payload).toEqual({
      streamUrl: "https://example.com/whip",
    })
  })
})
