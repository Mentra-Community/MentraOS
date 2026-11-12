/// <reference types="bun-types" />
import {beforeEach, describe, expect, mock, test} from "bun:test"

import type {WakeWordEvent} from "@mentra/bluetooth-sdk"

const configure = mock(async (_active: boolean, _modelDir?: string | null) => {})
mock.module("@mentra/bluetooth-sdk/internal", () => ({default: {setWakeWordDetection: configure}}))
let modelAvailable = true
const downloadWakeWordModel = mock(async (onProgress?: (percent: number) => void) => {
  onProgress?.(50)
  modelAvailable = true
})
mock.module("../OfflineSpeechModelService", () => ({default: {downloadWakeWordModel}}))
mock.module("../WakeWordModelManager", () => ({
  default: {
    isModelAvailable: async () => modelAvailable,
    getModelPath: () => "/documents/wake_word_models/hey-mentra",
  },
}))
const retryTimers: Array<() => void> = []
mock.module("../../utils/timers", () => ({
  BgTimer: {
    setTimeout: (callback: () => void) => {
      retryTimers.push(callback)
      return retryTimers.length
    },
    clearTimeout: (id: number) => {
      retryTimers[id - 1] = () => {}
    },
  },
}))
const {WakeWordService} = await import("../WakeWordService")
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
const ready: WakeWordEvent = {kind: "ready", phrase: "Hey Mentra", timestamp: 1}

beforeEach(() => {
  configure.mockClear()
  configure.mockImplementation(async () => {})
  downloadWakeWordModel.mockClear()
  modelAvailable = true
  retryTimers.length = 0
})

describe("on-device wake-word demand", () => {
  test("loads the Speech-page model for shared demand and releases it on last unsubscribe", async () => {
    const service = new WakeWordService()
    const emit = mock((_event: WakeWordEvent) => {})
    service.setSubscribed(true, emit)
    await settle()
    expect(configure.mock.calls).toEqual([[true, "/documents/wake_word_models/hey-mentra"]])
    expect(emit.mock.calls[0]?.[0]).toMatchObject({kind: "loading", phrase: "Hey Mentra"})
    expect(service.onNativeEvent(ready)).toEqual(ready)
    service.setSubscribed(true, emit)
    await settle()
    expect(configure).toHaveBeenCalledTimes(1)
    // A late subscriber is hydrated from the current status by the runtime.
    expect(service.currentStatus()).toEqual(ready)
    service.setSubscribed(false, emit)
    await settle()
    expect(configure.mock.calls.at(-1)).toEqual([false])
  })

  test("events describe only the wake-word model", async () => {
    const service = new WakeWordService()
    service.setSubscribed(true, () => {})
    await settle()
    const detected: WakeWordEvent = {kind: "detected", phrase: "Hey Mentra", timestamp: 2}
    expect(service.onNativeEvent(detected)).toEqual(detected)
    expect(service.currentStatus().kind).not.toBe("detected")
    expect(Object.keys(service.onNativeEvent(ready) ?? {})).not.toContain("transcriptionReady")
  })

  test("nothing is forwarded while detection is off", () => {
    const service = new WakeWordService()
    expect(service.onNativeEvent(ready)).toBeNull()
    expect(service.onNativeEvent({kind: "detected", phrase: "Hey Mentra", timestamp: 3})).toBeNull()
  })

  test("downloads a missing model first and reports progress as loading", async () => {
    modelAvailable = false
    const service = new WakeWordService()
    const emitted: WakeWordEvent[] = []
    service.setSubscribed(true, (event) => emitted.push(event))
    await settle()
    expect(downloadWakeWordModel).toHaveBeenCalledTimes(1)
    expect(emitted.map((event) => event.message)).toContain("Downloading the wake-word model (50%)")
    expect(configure).toHaveBeenCalledTimes(1)
  })

  test("a rejected start becomes an error event and retries on schedule", async () => {
    configure.mockImplementationOnce(async () => {
      throw new Error("model failed to load")
    })
    const service = new WakeWordService()
    const emitted: WakeWordEvent[] = []
    service.setSubscribed(true, (event) => emitted.push(event))
    await settle()
    expect(emitted.at(-1)).toMatchObject({kind: "error", message: expect.stringContaining("model failed to load")})
    expect(retryTimers).toHaveLength(1)
    retryTimers[0]()
    await settle()
    expect(configure).toHaveBeenCalledTimes(2)
  })

  test("a native error while running also retries", async () => {
    const service = new WakeWordService()
    service.setSubscribed(true, () => {})
    await settle()
    service.onNativeEvent({kind: "error", phrase: "Hey Mentra", timestamp: 4, message: "stream died"})
    expect(retryTimers).toHaveLength(1)
    retryTimers[0]()
    await settle()
    expect(configure).toHaveBeenCalledTimes(2)
  })

  test("a retry after unsubscribe does nothing", async () => {
    configure.mockImplementationOnce(async () => {
      throw new Error("model failed to load")
    })
    const service = new WakeWordService()
    service.setSubscribed(true, () => {})
    await settle()
    service.setSubscribed(false, () => {})
    await settle()
    const callsAfterStop = configure.mock.calls.length
    retryTimers[0]?.()
    await settle()
    expect(configure.mock.calls.length).toBe(callsAfterStop)
  })
})
