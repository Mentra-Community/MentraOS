const {warmUpCameraParamsForNative} = require("../_private/cameraRequestPayload")
const {photoRequestParamsForNative} = require("../_private/photoRequestPayload")

const baseParams = {
  requestId: "photo-1",
  size: "medium",
  webhookUrl: "https://example.com/upload",
  authToken: null,
  compress: "none",
  sound: true,
}

describe("photoRequestParamsForNative", () => {
  it("presends a thumbnail only when opted in, preserving the full-photo options", () => {
    expect(photoRequestParamsForNative(baseParams)).not.toHaveProperty("presend_thumbnail")
    expect(photoRequestParamsForNative({...baseParams, presend_thumbnail: false})).not.toHaveProperty("presend_thumbnail")
    expect(photoRequestParamsForNative({...baseParams, presend_thumbnail: true})).toEqual({
      ...photoRequestParamsForNative(baseParams), presend_thumbnail: true,
    })
    expect(photoRequestParamsForNative({...baseParams, presend_thumbnail: true, transferMethod: "direct"}).transferMethod).toBe("direct")
  })
  it("produces only supported native payload keys", () => {
    const payload = photoRequestParamsForNative(baseParams)
    expect(Object.keys(payload).sort()).toEqual(
      ["compress", "mode", "requestId", "size", "sound", "transferMethod", "webhookUrl"].sort(),
    )
    expect(payload.mode).toBe("photo")
  })

  it("omits requestId when omitted or blank so native can generate it", () => {
    const {requestId: _requestId, ...withoutRequestId} = baseParams

    expect(photoRequestParamsForNative(withoutRequestId)).not.toHaveProperty("requestId")
    expect(photoRequestParamsForNative({...baseParams, requestId: ""})).not.toHaveProperty("requestId")
    expect(photoRequestParamsForNative({...baseParams, requestId: "  "})).not.toHaveProperty("requestId")
  })

  it("preserves explicit requestId", () => {
    expect(photoRequestParamsForNative(baseParams).requestId).toBe("photo-1")
  })

  it("includes ISO only with manual exposure", () => {
    expect(photoRequestParamsForNative({...baseParams, iso: 400})).not.toHaveProperty("iso")

    const payload = photoRequestParamsForNative({
      ...baseParams,
      exposureTimeNs: 8_333_333,
      iso: 401.8,
    })

    expect(payload.exposureTimeNs).toBe(8_333_333)
    expect(payload.iso).toBe(402)
  })

  it("includes save only when explicitly set", () => {
    expect(photoRequestParamsForNative(baseParams)).not.toHaveProperty("save")
    expect(photoRequestParamsForNative({...baseParams, save: true}).save).toBe(true)
    expect(photoRequestParamsForNative({...baseParams, save: false}).save).toBe(false)
  })

  it("includes scan-mode booleans when explicitly set", () => {
    const payload = photoRequestParamsForNative({
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
    const payload = photoRequestParamsForNative({
      ...baseParams,
      mfnr: true,
      zsl: false,
    })

    expect(payload.mfnr).toBe(true)
    expect(payload.zsl).toBe(false)
  })

  it("omits zsl and mfnr when unset", () => {
    const payload = photoRequestParamsForNative(baseParams)
    expect(payload).not.toHaveProperty("zsl")
    expect(payload).not.toHaveProperty("mfnr")
  })

  it("preserves text capture mode", () => {
    expect(photoRequestParamsForNative({...baseParams, mode: "text"}).mode).toBe("text")
  })

  it("preserves explicit transfer methods and defaults to auto", () => {
    expect(photoRequestParamsForNative(baseParams).transferMethod).toBe("auto")
    expect(photoRequestParamsForNative({...baseParams, transferMethod: "direct"}).transferMethod).toBe("direct")
    expect(photoRequestParamsForNative({...baseParams, transferMethod: "ble"}).transferMethod).toBe("ble")
  })

  it("rejects an unknown transfer method at runtime", () => {
    expect(() => photoRequestParamsForNative({...baseParams, transferMethod: "wifi"} as any)).toThrow(
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
    expect(photoRequestParamsForNative({...baseParams, compress}).compress).toBe(compress)
  })
  it("defaults omission to none", () => {
    expect(photoRequestParamsForNative({...baseParams, compress: undefined}).compress).toBe("none")
  })
  it.each(["heavy", "", "HIGH", null, 1, false])("rejects invalid compression %p", (compress) => {
    expect(() => photoRequestParamsForNative({...baseParams, compress} as never)).toThrow("Invalid photo compression")
  })
})
