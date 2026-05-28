import {photoRequestParamsForNative} from "../_private/photoRequestPayload"
import type {PhotoRequestParams} from "../BluetoothSdk.types"

const baseParams: PhotoRequestParams = {
  requestId: "photo-1",
  appId: "com.test.app",
  size: "medium",
  webhookUrl: "https://example.com/upload",
  authToken: null,
  compress: "none",
  sound: true,
}

describe("photoRequestParamsForNative", () => {
  it("defaults includeImu to false when omitted", () => {
    const payload = photoRequestParamsForNative(baseParams)
    expect(payload.includeImu).toBe(false)
  })

  it("passes includeImu=true through to native payload", () => {
    const payload = photoRequestParamsForNative({
      ...baseParams,
      includeImu: true,
    })
    expect(payload.includeImu).toBe(true)
  })
})
