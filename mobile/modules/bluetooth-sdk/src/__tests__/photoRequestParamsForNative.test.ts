const {photoRequestParamsForNative} = require("../_private/photoRequestPayload")

const baseParams = {
  requestId: "photo-1",
  appId: "com.test.app",
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
      ["appId", "compress", "flash", "requestId", "size", "sound", "webhookUrl"].sort(),
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
