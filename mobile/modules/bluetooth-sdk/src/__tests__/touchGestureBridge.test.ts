import NativeBluetoothSdk from "../_private/BluetoothSdkModule"
import type {TouchGesture} from "../BluetoothSdk.types"

jest.mock("../_private/BluetoothSdkModule", () => ({
  __esModule: true,
  default: {setTouchGestureDefaultBehaviorEnabled: jest.fn()},
}))

const {BluetoothSdk} = jest.requireActual<typeof import("../index")>("../index")

const gestures: TouchGesture[] = [
  "single_tap",
  "double_tap",
  "triple_tap",
  "long_press",
  "forward_swipe",
  "backward_swipe",
  "up_swipe",
  "down_swipe",
]

describe("touch gesture default behavior", () => {
  const nativeCall = jest.mocked(NativeBluetoothSdk.setTouchGestureDefaultBehaviorEnabled)
  beforeEach(() => nativeCall.mockReset())

  it.each(gestures)("forwards %s enable and disable with the terminal acknowledgement", async (gesture) => {
    for (const enabled of [false, true]) {
      const ack = {
        type: "settings_ack" as const,
        requestId: "touch-1",
        setting: "touch_gesture_default" as const,
        status: "applied" as const,
        timestamp: 123,
        gesture,
        enabled,
      }
      nativeCall.mockResolvedValue(ack)
      await expect(BluetoothSdk.setTouchGestureDefaultBehaviorEnabled(gesture, enabled)).resolves.toEqual(ack)
      expect(nativeCall).toHaveBeenLastCalledWith(gesture, enabled)
    }
  })

  it("rejects unsupported firmware instead of claiming the stock action was disabled", async () => {
    const error = new Error("settings timeout")
    nativeCall.mockRejectedValue(error)
    await expect(BluetoothSdk.setTouchGestureDefaultBehaviorEnabled("double_tap", false)).rejects.toBe(error)
  })
})
