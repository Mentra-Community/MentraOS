import BluetoothSdk, {TouchEvent} from "@mentra/bluetooth-sdk"

// Helpers for onboarding steps that wait for a glasses interaction. Each takes
// an AbortSignal and removes its listener both when it fires AND when the step
// is left (signal aborts), so listeners never leak across re-renders.

// Resolve once a button press matching `pressTypes` arrives.
//
// NOTE: the native button_press event delivered to JS is {buttonId, pressType,
// timestamp} with NO `type` field (see BluetoothSdkModule on both iOS and
// Android), so we must NOT gate on data.type — doing so silently never resolves
// and the "take a photo" / recording onboarding steps get stuck. The listener
// is already scoped to the "button_press" event name, so matching on pressType
// alone is correct.
export const waitForButtonPress = (signal: AbortSignal, pressTypes: string[]): Promise<void> => {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const unsub = BluetoothSdk.addListener("button_press", (data: any) => {
      if (pressTypes.includes(data?.pressType)) {
        unsub.remove()
        signal.removeEventListener("abort", onAbort)
        resolve()
      }
    })
    const onAbort = () => {
      unsub.remove()
    }
    signal.addEventListener("abort", onAbort)
  })
}

// Resolve once a touch gesture in `gestureNames` arrives.
export const waitForTouchGesture = (signal: AbortSignal, gestureNames: string[]): Promise<void> => {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const unsub = BluetoothSdk.addListener("touch_event", (data: TouchEvent) => {
      if (data?.gestureName && gestureNames.includes(data.gestureName)) {
        unsub.remove()
        signal.removeEventListener("abort", onAbort)
        resolve()
      }
    })
    const onAbort = () => {
      unsub.remove()
    }
    signal.addEventListener("abort", onAbort)
  })
}
