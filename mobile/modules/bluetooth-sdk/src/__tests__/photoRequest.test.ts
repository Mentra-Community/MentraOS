const {normalizePhotoRequestParams} = require("../photoRequest")

const baseParams = {
  requestId: "photo-1",
  size: "medium",
  sound: true,
}

describe("normalizePhotoRequestParams", () => {
  describe("destination arms", () => {
    it("maps the webhook arm onto the native dict", () => {
      const payload = normalizePhotoRequestParams({
        ...baseParams,
        destination: {
          kind: "webhook",
          url: "https://example.com/upload",
          authToken: "token-1",
          transferMethod: "direct",
          keepOnGlasses: true,
          compress: "medium",
        },
      })

      expect(payload.destinationKind).toBe("webhook")
      expect(payload.webhookUrl).toBe("https://example.com/upload")
      expect(payload.authToken).toBe("token-1")
      expect(payload.transferMethod).toBe("direct")
      expect(payload.save).toBe(true)
      expect(payload.compress).toBe("medium")
      expect(payload.saveToCameraRoll).toBe(false)
    })

    it("defaults the webhook arm to auto transfer and no glasses copy", () => {
      const payload = normalizePhotoRequestParams({
        ...baseParams,
        destination: {kind: "webhook", url: "https://example.com/upload"},
      })

      expect(payload.transferMethod).toBe("auto")
      expect(payload.save).toBe(false)
      expect(payload).not.toHaveProperty("authToken")
    })

    it("maps the phone arm: BLE transfer, no webhook fields", () => {
      const payload = normalizePhotoRequestParams({
        ...baseParams,
        destination: {kind: "phone", saveToCameraRoll: true},
      })

      expect(payload.destinationKind).toBe("phone")
      expect(payload.transferMethod).toBe("ble")
      expect(payload.webhookUrl).toBe("")
      expect(payload).not.toHaveProperty("authToken")
      expect(payload.save).toBe(false)
      expect(payload.saveToCameraRoll).toBe(true)
    })

    it("forces BLE transfer on the phone arm even without options", () => {
      const payload = normalizePhotoRequestParams({...baseParams, destination: {kind: "phone"}})

      expect(payload.transferMethod).toBe("ble")
      expect(payload.saveToCameraRoll).toBe(false)
    })

    it("keeps a glasses copy for the phone arm when keepOnGlasses is set", () => {
      const payload = normalizePhotoRequestParams({
        ...baseParams,
        destination: {kind: "phone", keepOnGlasses: true},
      })

      expect(payload.save).toBe(true)
      expect(payload.transferMethod).toBe("ble")
    })

    it("maps the glasses arm: save true, no webhook fields", () => {
      const payload = normalizePhotoRequestParams({...baseParams, destination: {kind: "glasses"}})

      expect(payload.destinationKind).toBe("glasses")
      expect(payload.save).toBe(true)
      expect(payload.transferMethod).toBe("auto")
      expect(payload.webhookUrl).toBe("")
      expect(payload).not.toHaveProperty("authToken")
      expect(payload.saveToCameraRoll).toBe(false)
    })
  })

  describe("webhook arm validation", () => {
    it.each(["", "   "])("throws when the webhook url is blank (%j)", (url) => {
      expect(() =>
        normalizePhotoRequestParams({...baseParams, destination: {kind: "webhook", url, keepOnGlasses: true}}),
      ).toThrow(/requires a non-empty url/)
    })
  })

  describe("legacy destination derivation", () => {
    it("derives a webhook destination from flat webhookUrl fields", () => {
      const payload = normalizePhotoRequestParams({
        ...baseParams,
        webhookUrl: "https://example.com/upload",
        authToken: "token-2",
        transferMethod: "ble",
        save: true,
        compress: "heavy",
      })

      expect(payload.destinationKind).toBe("webhook")
      expect(payload.webhookUrl).toBe("https://example.com/upload")
      expect(payload.authToken).toBe("token-2")
      expect(payload.transferMethod).toBe("ble")
      expect(payload.save).toBe(true)
      expect(payload.compress).toBe("heavy")
      expect(payload.saveToCameraRoll).toBe(false)
    })

    it("derives keepOnGlasses false when legacy save is unset", () => {
      const payload = normalizePhotoRequestParams({
        ...baseParams,
        webhookUrl: "https://example.com/upload",
        authToken: null,
      })

      expect(payload.destinationKind).toBe("webhook")
      expect(payload.save).toBe(false)
      expect(payload.transferMethod).toBe("auto")
    })

    it("derives the glasses arm from save-only requests", () => {
      const payload = normalizePhotoRequestParams({...baseParams, webhookUrl: null, save: true})

      expect(payload.destinationKind).toBe("glasses")
      expect(payload.save).toBe(true)
      expect(payload.webhookUrl).toBe("")
    })

    it("throws when there is no webhook and no save", () => {
      expect(() => normalizePhotoRequestParams({...baseParams})).toThrow(TypeError)
      expect(() => normalizePhotoRequestParams({...baseParams, webhookUrl: "  ", save: false})).toThrow(
        /no destination/,
      )
    })
  })

  describe("mixed old/new destination fields", () => {
    const destination = {kind: "phone"} as const

    it.each([
      ["webhookUrl", {webhookUrl: "https://example.com/upload"}],
      ["authToken", {authToken: "token"}],
      ["transferMethod", {transferMethod: "auto"}],
      ["save", {save: false}],
      ["compress", {compress: "none"}],
    ])("throws when destination is combined with flat %s", (field, flat) => {
      expect(() => normalizePhotoRequestParams({...baseParams, destination, ...flat})).toThrow(
        new RegExp(`destination cannot be combined .*${field}`),
      )
    })

    it("allows explicit null legacy fields alongside destination", () => {
      const payload = normalizePhotoRequestParams({
        ...baseParams,
        destination,
        webhookUrl: null,
        authToken: null,
      })

      expect(payload.destinationKind).toBe("phone")
    })
  })

  describe("loopback webhook validation", () => {
    it.each([
      "http://127.0.0.1:8080/upload",
      "http://127.0.0.2/upload",
      "http://127.255.255.254/upload",
      "http://127.1/upload",
      "http://127.0.1/upload",
      "http://2130706433/upload",
      "http://0x7f.1/upload",
      "http://0177.0.0.1/upload",
      "http://169.254.1/upload",
      "http://[::1]:8080/upload",
      "http://[0:0::1]/upload",
      "http://[0:0:0:0:0:0:0:1]/upload",
      "http://[::ffff:127.0.0.1]/upload",
      "http://[::FFFF:169.254.1.2]/upload",
      "http://[fe80::1%25en0]:8080/upload",
      "http://[FE90::1]/upload",
      "http://[febf:0:0:0:1:2:3:4]/upload",
      "http://localhost/upload",
      "http://169.254.12.34:9090/upload",
    ])("throws for direct transfer to phone-only host %s", (url) => {
      expect(() =>
        normalizePhotoRequestParams({
          ...baseParams,
          destination: {kind: "webhook", url, transferMethod: "direct"},
        }),
      ).toThrow(/only reachable from this phone/)
    })

    it("allows loopback webhooks with auto or ble transfer", () => {
      for (const transferMethod of ["auto", "ble"] as const) {
        const payload = normalizePhotoRequestParams({
          ...baseParams,
          destination: {kind: "webhook", url: "http://127.0.0.1:8080/upload", transferMethod},
        })
        expect(payload.transferMethod).toBe(transferMethod)
      }
    })

    it.each([
      "http://192.168.1.20:8080/upload",
      "http://[2001:db8::1]/upload",
      "http://[fec0::1]/upload",
      "http://[::ffff:192.168.1.20]/upload",
      "http://[::2]/upload",
      "http://192.168.1/upload",
      "http://3232235796/upload",
      "https://uploads.example.com/upload",
    ])("allows direct transfer to routable host %s", (url) => {
      const payload = normalizePhotoRequestParams({
        ...baseParams,
        destination: {kind: "webhook", url, transferMethod: "direct"},
      })
      expect(payload.transferMethod).toBe("direct")
    })

    it("also applies to legacy flat webhook fields", () => {
      expect(() =>
        normalizePhotoRequestParams({
          ...baseParams,
          webhookUrl: "http://localhost:8080/upload",
          transferMethod: "direct",
        }),
      ).toThrow(/only reachable from this phone/)
    })
  })

  it("keeps flat capture fields and native payload conventions intact", () => {
    const payload = normalizePhotoRequestParams({
      ...baseParams,
      size: "large",
      mode: "text",
      noiseReduction: false,
      ispDigitalGain: 0,
      exposureTimeNs: 8_333_333,
      iso: 401.8,
      zsl: false,
      destination: {kind: "phone"},
    })

    expect(payload.size).toBe("high")
    expect(payload.mode).toBe("text")
    expect(payload.noiseReduction).toBe(false)
    expect(payload.ispDigitalGain).toBe(0)
    expect(payload.exposureTimeNs).toBe(8_333_333)
    expect(payload.iso).toBe(402)
    expect(payload.zsl).toBe(false)
    expect(payload.requestId).toBe("photo-1")
  })
})
