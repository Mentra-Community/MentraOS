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
  it("produces only supported native payload keys", () => {
    const payload = photoRequestParamsForNative(baseParams)
    expect(Object.keys(payload).sort()).toEqual(
      ["compress", "requestId", "size", "sound", "webhookUrl"].sort(),
    )
  })

  it("generates requestId when omitted or blank", () => {
    const {requestId: _requestId, ...withoutRequestId} = baseParams

    expect(photoRequestParamsForNative(withoutRequestId).requestId).toMatch(/^photo-/)
    expect(photoRequestParamsForNative({...baseParams, requestId: ""}).requestId).toMatch(/^photo-/)
    expect(photoRequestParamsForNative({...baseParams, requestId: "  "}).requestId).toMatch(/^photo-/)
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
})

describe("warmUpCameraParamsForNative", () => {
  it("generates requestId and normalizes warm-up fields", () => {
    const payload = warmUpCameraParamsForNative({
      size: "large",
      exposureTimeNs: 8_333_333,
      durationMs: 12_345.6,
    })

    expect(payload.requestId).toMatch(/^warm-/)
    expect(payload.size).toBe("high")
    expect(payload.exposureTimeNs).toBe(8_333_333)
    expect(payload.durationMs).toBe(12_346)
  })

  it("preserves explicit warm-up requestId", () => {
    expect(warmUpCameraParamsForNative({requestId: "warm-1", size: "medium"}).requestId).toBe("warm-1")
  })
})
