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
