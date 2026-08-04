import {waitForButtonPress, waitForTouchGesture} from "@/components/onboarding/waitForGlassesEvent"
import {emitBluetoothSdkEvent, getBluetoothSdkListenerCount, resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"

describe("waitForGlassesEvent", () => {
  beforeEach(() => {
    resetBluetoothSdkMock()
  })

  describe("waitForButtonPress", () => {
    it("resolves on a real (type-less) button_press payload", async () => {
      const controller = new AbortController()
      const done = waitForButtonPress(controller.signal, ["short"])

      // This is exactly what the native module sends to JS: NO `type` field.
      // The old code gated on data.type === "button_press" and never resolved,
      // leaving the "take a photo" step stuck.
      emitBluetoothSdkEvent("button_press", {buttonId: "camera", pressType: "short", timestamp: 123})

      await expect(done).resolves.toBeUndefined()
      // Listener removed after resolving.
      expect(getBluetoothSdkListenerCount("button_press")).toBe(0)
    })

    it("matches any of the accepted press types (long or short)", async () => {
      const controller = new AbortController()
      const done = waitForButtonPress(controller.signal, ["long", "short"])

      emitBluetoothSdkEvent("button_press", {buttonId: "camera", pressType: "long", timestamp: 1})

      await expect(done).resolves.toBeUndefined()
    })

    it("ignores press types that do not match", () => {
      const controller = new AbortController()
      let resolved = false
      waitForButtonPress(controller.signal, ["short"]).then(() => {
        resolved = true
      })

      emitBluetoothSdkEvent("button_press", {buttonId: "camera", pressType: "long", timestamp: 1})

      expect(resolved).toBe(false)
      expect(getBluetoothSdkListenerCount("button_press")).toBe(1)
    })

    it("removes its listener when the signal aborts (no leak)", () => {
      const controller = new AbortController()
      waitForButtonPress(controller.signal, ["short"])
      expect(getBluetoothSdkListenerCount("button_press")).toBe(1)

      controller.abort()
      expect(getBluetoothSdkListenerCount("button_press")).toBe(0)
    })
  })

  describe("waitForTouchGesture", () => {
    it("resolves on a matching gesture and removes its listener", async () => {
      const controller = new AbortController()
      const done = waitForTouchGesture(controller.signal, ["double_tap"])

      emitBluetoothSdkEvent("touch_event", {type: "touch_event", gestureName: "double_tap", timestamp: 1})

      await expect(done).resolves.toBeUndefined()
      expect(getBluetoothSdkListenerCount("touch_event")).toBe(0)
    })

    it("removes its listener when the signal aborts (no leak)", () => {
      const controller = new AbortController()
      waitForTouchGesture(controller.signal, ["double_tap"])
      expect(getBluetoothSdkListenerCount("touch_event")).toBe(1)

      controller.abort()
      expect(getBluetoothSdkListenerCount("touch_event")).toBe(0)
    })
  })
})
