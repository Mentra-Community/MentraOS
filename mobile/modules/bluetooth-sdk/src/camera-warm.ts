import type {BluetoothSdkPublicModule, CameraStatusEvent, CameraWarmHold, HoldCameraWarmParams} from "./BluetoothSdk.types"

/** The glasses keep one warm-up lease 5 minutes at most. */
export const CAMERA_WARM_LEASE_MS = 5 * 60_000
/** A held warm-up re-arms its lease this often, well before it lapses. */
export const CAMERA_WARM_RENEW_MS = 4 * 60_000
/** A re-arm that failed (the camera taking a photo, the glasses away) is tried again after this long. */
export const CAMERA_WARM_RETRY_MS = 5_000

type Sdk = Pick<BluetoothSdkPublicModule, "warmUpCamera" | "stopCameraWarmUp" | "addListener">
/** A wait. A JS timer by default, which Android pauses while the app is in the background: pass one that isn't. */
export type Wait = (ms: number) => Promise<void>

const jsWait: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Keep the glasses camera warm until released, so each photo with the same settings is taken at once. A warm-up
 * lease lasts 5 minutes at most on the glasses: the hold re-arms it (the same request ID, which only restarts the
 * glasses' keep-alive) before it lapses, and at once when the camera reports it stopped, as after the glasses
 * restart. Resolves once the camera is first warm; rejects if it can't warm then.
 */
export async function holdCameraWarm(sdk: Sdk, params: HoldCameraWarmParams, wait: Wait = jsWait): Promise<CameraWarmHold> {
  const requestId = `warm-hold-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  let released = false
  let wake = () => {}
  const arm = () => sdk.warmUpCamera({...params, requestId, durationMs: CAMERA_WARM_LEASE_MS})
  const stopped = sdk.addListener("camera_status", (event: CameraStatusEvent) => {
    if (event.requestId === requestId && event.state === "stopped") wake()
  })
  try {
    await arm()
  } catch (error) {
    stopped.remove()
    throw error
  }
  void (async () => {
    let next = CAMERA_WARM_RENEW_MS
    while (!released) {
      await Promise.race([wait(next), new Promise<void>((resolve) => (wake = resolve))])
      if (released) return
      next = await arm().then(
        () => CAMERA_WARM_RENEW_MS,
        () => CAMERA_WARM_RETRY_MS,
      )
    }
  })()
  return {
    requestId,
    release: async () => {
      if (released) return
      released = true
      wake()
      stopped.remove()
      await sdk.stopCameraWarmUp(requestId)
    },
  }
}
