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
})
