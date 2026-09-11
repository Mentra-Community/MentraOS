import {shouldUseMentraLiveNativeCapture} from "./buttonCapturePolicy"

describe("Mentra Live button capture policy", () => {
  it("uses native photo/video capture when no miniapp subscribes to button presses", () => {
    expect(shouldUseMentraLiveNativeCapture([])).toBe(true)
  })

  it("routes button presses to miniapps when at least one active subscriber exists", () => {
    expect(shouldUseMentraLiveNativeCapture(["com.example.subscriber"])).toBe(false)
  })
})
