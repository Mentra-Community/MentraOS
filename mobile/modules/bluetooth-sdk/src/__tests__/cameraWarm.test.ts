
import {CAMERA_WARM_LEASE_MS, CAMERA_WARM_RENEW_MS, CAMERA_WARM_RETRY_MS, holdCameraWarm} from "../camera-warm"
import type {CameraStatusEvent, WarmUpCameraParams} from "../BluetoothSdk.types"

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

/** A Bluetooth SDK whose warm-ups resolve, or reject while `busy`, and whose camera_status the test emits. */
function sdk() {
  const calls: string[] = []
  let busy = false
  let listener: ((event: CameraStatusEvent) => void) | undefined
  const fake = {
    warmUpCamera: async (params: WarmUpCameraParams) => {
      calls.push(`warm ${params.requestId} ${params.durationMs} ${params.size}`)
      if (busy) throw new Error("camera_busy")
      return {type: "camera_status", requestId: params.requestId!, state: "ready", timestamp: 0} as CameraStatusEvent
    },
    stopCameraWarmUp: async (requestId: string) => void calls.push(`stop ${requestId}`),
    addListener: (_name: string, next: (event: CameraStatusEvent) => void) => {
      listener = next
      return {remove: () => (listener = undefined)}
    },
  }
  return {
    fake: fake as never,
    calls,
    setBusy: (value: boolean) => (busy = value),
    emit: (event: Partial<CameraStatusEvent>) => listener?.(event as CameraStatusEvent),
    listening: () => listener !== undefined,
  }
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test("a hold warms once, re-arms the same lease before it lapses, and stops on release", async () => {
  const {fake, calls, listening} = sdk()
  const hold = await holdCameraWarm(fake, {size: "medium"})
  expect(calls).toEqual([`warm ${hold.requestId} ${CAMERA_WARM_LEASE_MS} medium`])
  jest.advanceTimersByTime(CAMERA_WARM_RENEW_MS)
  await flush()
  jest.advanceTimersByTime(CAMERA_WARM_RENEW_MS)
  await flush()
  expect(calls.length).toBe(3)
  expect(new Set(calls)).toEqual(new Set([calls[0]]))
  await hold.release()
  await hold.release()
  expect(calls.at(-1)).toBe(`stop ${hold.requestId}`)
  expect(calls.filter((call) => call.startsWith("stop")).length).toBe(1)
  expect(listening()).toBe(false)
  jest.advanceTimersByTime(CAMERA_WARM_RENEW_MS * 3)
  await flush()
  expect(calls.length).toBe(4)
})

test("a re-arm refused while the camera takes a photo is tried again soon", async () => {
  const {fake, calls, setBusy} = sdk()
  await holdCameraWarm(fake, {size: "medium"})
  setBusy(true)
  jest.advanceTimersByTime(CAMERA_WARM_RENEW_MS)
  await flush()
  setBusy(false)
  jest.advanceTimersByTime(CAMERA_WARM_RETRY_MS)
  await flush()
  expect(calls.length).toBe(3)
})

test("a camera that stopped (the glasses restarted) is warmed again at once", async () => {
  const {fake, calls, emit} = sdk()
  const hold = await holdCameraWarm(fake, {size: "medium"})
  emit({requestId: "someone-else", state: "stopped"})
  await flush()
  expect(calls.length).toBe(1)
  emit({requestId: hold.requestId, state: "stopped"})
  await flush()
  expect(calls.length).toBe(2)
})

test("renewals run on the wait it is given, as the engine's background-safe timer", async () => {
  const {fake, calls} = sdk()
  const waits: number[] = []
  let resolveWait = () => {}
  const wait = (ms: number) => {
    waits.push(ms)
    return new Promise<void>((resolve) => (resolveWait = resolve))
  }
  const hold = await holdCameraWarm(fake, {size: "medium"}, wait)
  await flush()
  expect(waits).toEqual([CAMERA_WARM_RENEW_MS])
  resolveWait()
  await flush()
  expect(calls.length).toBe(2)
  await hold.release()
})

test("a hold that can't warm rejects and holds nothing", async () => {
  const {fake, setBusy, listening} = sdk()
  setBusy(true)
  await expect(holdCameraWarm(fake, {size: "medium"})).rejects.toThrow("camera_busy")
  expect(listening()).toBe(false)
})
