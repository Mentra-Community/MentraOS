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

  describe("mixed old/new exposure fields", () => {
    const exposure = {kind: "auto"} as const

    it.each([
      ["exposureTimeNs", {exposureTimeNs: 8_333_333}],
      ["iso", {iso: 400}],
      ["aeExposureDivisor", {aeExposureDivisor: 3}],
      ["isoCap", {isoCap: 800}],
      ["zsl", {zsl: true}],
      ["mfnr", {mfnr: false}],
    ])("throws when exposure is combined with flat %s", (field, flat) => {
      expect(() =>
        normalizePhotoRequestParams({...baseParams, destination: {kind: "glasses"}, exposure, ...flat}),
      ).toThrow(new RegExp(`exposure cannot be combined .*${field}`))
    })
  })

  describe("loopback webhook validation", () => {
    it.each(["http://127.0.0.1:8080/upload", "http://localhost/upload", "http://169.254.12.34:9090/upload"])(
      "throws for direct transfer to phone-only host %s",
      (url) => {
        expect(() =>
          normalizePhotoRequestParams({
            ...baseParams,
            destination: {kind: "webhook", url, transferMethod: "direct"},
          }),
        ).toThrow(/only reachable from this phone/)
      },
    )

    it("allows loopback webhooks with auto or ble transfer", () => {
      for (const transferMethod of ["auto", "ble"] as const) {
        const payload = normalizePhotoRequestParams({
          ...baseParams,
          destination: {kind: "webhook", url: "http://127.0.0.1:8080/upload", transferMethod},
        })
        expect(payload.transferMethod).toBe(transferMethod)
      }
    })

    it("allows direct transfer to a routable host", () => {
      const payload = normalizePhotoRequestParams({
        ...baseParams,
        destination: {kind: "webhook", url: "http://192.168.1.20:8080/upload", transferMethod: "direct"},
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

  describe("exposure arms", () => {
    const destination = {kind: "glasses"} as const

    it("maps the manual arm onto exposureTimeNs and iso", () => {
      const payload = normalizePhotoRequestParams({
        ...baseParams,
        destination,
        exposure: {kind: "manual", timeNs: 8_333_333, iso: 401.8},
      })

      expect(payload.exposureTimeNs).toBe(8_333_333)
      expect(payload.iso).toBe(402)
    })

    it("maps the scan arm onto aeExposureDivisor and isoCap", () => {
      const payload = normalizePhotoRequestParams({
        ...baseParams,
        destination,
        exposure: {kind: "scan", aeExposureDivisor: 3, isoCap: 800},
      })

      expect(payload.aeExposureDivisor).toBe(3)
      expect(payload.isoCap).toBe(800)
      expect(payload).not.toHaveProperty("exposureTimeNs")
    })

    it("maps the auto arm onto zsl and mfnr", () => {
      const payload = normalizePhotoRequestParams({
        ...baseParams,
        destination,
        exposure: {kind: "auto", zsl: false, mfnr: true},
      })

      expect(payload.zsl).toBe(false)
      expect(payload.mfnr).toBe(true)
    })

    it("derives the manual arm from legacy exposureTimeNs/iso", () => {
      const payload = normalizePhotoRequestParams({
        ...baseParams,
        destination,
        exposureTimeNs: 8_333_333,
        iso: 400,
      })

      expect(payload.exposureTimeNs).toBe(8_333_333)
      expect(payload.iso).toBe(400)
    })

    it("derives the scan arm from legacy aeExposureDivisor/isoCap", () => {
      const payload = normalizePhotoRequestParams({...baseParams, destination, aeExposureDivisor: 5, isoCap: 400})

      expect(payload.aeExposureDivisor).toBe(5)
      expect(payload.isoCap).toBe(400)
    })

    it("derives the auto arm from legacy zsl/mfnr and defaults to omitting them", () => {
      const payload = normalizePhotoRequestParams({...baseParams, destination, zsl: true, mfnr: false})
      expect(payload.zsl).toBe(true)
      expect(payload.mfnr).toBe(false)

      const defaults = normalizePhotoRequestParams({...baseParams, destination})
      expect(defaults).not.toHaveProperty("zsl")
      expect(defaults).not.toHaveProperty("mfnr")
    })
  })

  it("keeps flat capture fields and native payload conventions intact", () => {
    const payload = normalizePhotoRequestParams({
      ...baseParams,
      size: "large",
      mode: "text",
      noiseReduction: false,
      ispDigitalGain: 0,
      destination: {kind: "phone"},
    })

    expect(payload.size).toBe("high")
    expect(payload.mode).toBe("text")
    expect(payload.noiseReduction).toBe(false)
    expect(payload.ispDigitalGain).toBe(0)
    expect(payload.requestId).toBe("photo-1")
  })
})
