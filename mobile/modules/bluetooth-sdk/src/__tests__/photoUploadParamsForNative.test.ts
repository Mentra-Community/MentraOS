const {warmUpCameraParamsForNative} = require("../_private/cameraRequestPayload")
const {photoCaptureParamsForNative, photoUploadParamsForNative} = require("../_private/photoRequestPayload")

const baseParams = {
  requestId: "photo-1",
  size: "medium",
  webhookUrl: "https://example.com/upload",
  authToken: null,
  compress: "none",
  sound: true,
}

describe("photoUploadParamsForNative", () => {
  it("sends a capture's settings without an upload target", () => {
    const {webhookUrl: _webhook, authToken: _token, ...capture} = baseParams
    const request = photoUploadParamsForNative(baseParams)
    const {transferMethod: _method, webhookUrl: _url, ...settings} = request
    expect(photoCaptureParamsForNative(capture)).toEqual(settings)
  })
  it("sends size auto when a capture names none, and keeps a named size", () => {
    expect(photoCaptureParamsForNative({sound: true}).size).toBe("auto")
    expect(photoCaptureParamsForNative({size: "auto", sound: true}).size).toBe("auto")
    expect(photoCaptureParamsForNative({size: "high", sound: true}).size).toBe("high")
  })
  it("produces only supported native payload keys", () => {
    const payload = photoUploadParamsForNative(baseParams)
    expect(Object.keys(payload).sort()).toEqual(
      ["compress", "mode", "requestId", "size", "sound", "transferMethod", "webhookUrl"].sort(),
    )
    expect(payload.mode).toBe("photo")
  })

  it("omits requestId when omitted or blank so native can generate it", () => {
    const {requestId: _requestId, ...withoutRequestId} = baseParams

    expect(photoUploadParamsForNative(withoutRequestId)).not.toHaveProperty("requestId")
    expect(photoUploadParamsForNative({...baseParams, requestId: ""})).not.toHaveProperty("requestId")
    expect(photoUploadParamsForNative({...baseParams, requestId: "  "})).not.toHaveProperty("requestId")
  })

  it("preserves explicit requestId", () => {
    expect(photoUploadParamsForNative(baseParams).requestId).toBe("photo-1")
  })

  it("includes ISO only with manual exposure", () => {
    expect(photoUploadParamsForNative({...baseParams, iso: 400})).not.toHaveProperty("iso")

    const payload = photoUploadParamsForNative({
      ...baseParams,
      exposureTimeNs: 8_333_333,
      iso: 401.8,
    })

    expect(payload.exposureTimeNs).toBe(8_333_333)
    expect(payload.iso).toBe(402)
  })

  it("includes save only when explicitly set", () => {
    expect(photoUploadParamsForNative(baseParams)).not.toHaveProperty("save")
    expect(photoUploadParamsForNative({...baseParams, save: true}).save).toBe(true)
    expect(photoUploadParamsForNative({...baseParams, save: false}).save).toBe(false)
  })

  it("includes scan-mode booleans when explicitly set", () => {
    const payload = photoUploadParamsForNative({
      ...baseParams,
      mfnr: false,
      zsl: false,
      aeExposureDivisor: 3,
      isoCap: 800,
    })

    expect(payload.mfnr).toBe(false)
    expect(payload.zsl).toBe(false)
    expect(payload.aeExposureDivisor).toBe(3)
    expect(payload.isoCap).toBe(800)
  })

  it("includes zsl and mfnr independently when set", () => {
    const payload = photoUploadParamsForNative({
      ...baseParams,
      mfnr: true,
      zsl: false,
    })

    expect(payload.mfnr).toBe(true)
    expect(payload.zsl).toBe(false)
  })

  it("omits zsl and mfnr when unset", () => {
    const payload = photoUploadParamsForNative(baseParams)
    expect(payload).not.toHaveProperty("zsl")
    expect(payload).not.toHaveProperty("mfnr")
  })

  it("preserves text capture mode", () => {
    expect(photoUploadParamsForNative({...baseParams, mode: "text"}).mode).toBe("text")
  })

  it("preserves explicit transfer methods and defaults to auto", () => {
    expect(photoUploadParamsForNative(baseParams).transferMethod).toBe("auto")
    expect(photoUploadParamsForNative({...baseParams, transferMethod: "direct"}).transferMethod).toBe("direct")
    expect(photoUploadParamsForNative({...baseParams, transferMethod: "ble"}).transferMethod).toBe("ble")
  })

  it("rejects an unknown transfer method at runtime", () => {
    expect(() => photoUploadParamsForNative({...baseParams, transferMethod: "wifi"} as any)).toThrow(
      'Invalid transferMethod "wifi". Expected "auto", "direct", or "ble".',
    )
  })
})

describe("warmUpCameraParamsForNative", () => {
  it("omits requestId and normalizes warm-up fields so native can generate it", () => {
    const payload = warmUpCameraParamsForNative({
      size: "large",
      exposureTimeNs: 8_333_333,
      durationMs: 12_345.6,
    })

    expect(payload).not.toHaveProperty("requestId")
    expect(payload.size).toBe("high")
    expect(payload.mode).toBe("photo")
    expect(payload.exposureTimeNs).toBe(8_333_333)
    expect(payload.durationMs).toBe(12_346)
  })

  it("preserves explicit warm-up requestId", () => {
    expect(warmUpCameraParamsForNative({requestId: "warm-1", size: "medium"}).requestId).toBe("warm-1")
  })

  it("preserves text warm-up mode for ASG sensor-constant resolution", () => {
    expect(warmUpCameraParamsForNative({size: "low", mode: "text"}).mode).toBe("text")
  })

  it("includes zsl and mfnr independently when set", () => {
    const payload = warmUpCameraParamsForNative({
      size: "medium",
      zsl: false,
      mfnr: true,
    })

    expect(payload.zsl).toBe(false)
    expect(payload.mfnr).toBe(true)
  })

  it("omits zsl and mfnr when unset", () => {
    const payload = warmUpCameraParamsForNative({size: "medium"})
    expect(payload).not.toHaveProperty("zsl")
    expect(payload).not.toHaveProperty("mfnr")
  })
})

describe("canonical photo compression", () => {
  it.each(["none", "low", "medium", "high"] as const)("sends %s unchanged", (compress) => {
    expect(photoUploadParamsForNative({...baseParams, compress}).compress).toBe(compress)
  })
  it("defaults omission to none", () => {
    expect(photoUploadParamsForNative({...baseParams, compress: undefined}).compress).toBe("none")
  })
  it.each(["heavy", "", "HIGH", null, 1, false])("rejects invalid compression %p", (compress) => {
    expect(() => photoUploadParamsForNative({...baseParams, compress} as never)).toThrow("Invalid photo compression")
  })
})
