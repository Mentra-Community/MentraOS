import {afterEach, describe, expect, mock, test} from "bun:test"

import {DEFAULT_CAPTION_TIMEOUT_SECONDS} from "../../shared/types"
import {CaptionsController, isSupportedCaptionTimeoutSeconds} from "./CaptionsController"

describe("CaptionsController caption timeout", () => {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  })

  test("supports each timeout preset and rejects arbitrary values", () => {
    expect([3, 5, 10, 30, 40].every(isSupportedCaptionTimeoutSeconds)).toBe(true)
    expect(isSupportedCaptionTimeoutSeconds(0)).toBe(false)
    expect(isSupportedCaptionTimeoutSeconds(4)).toBe(false)
    expect(isSupportedCaptionTimeoutSeconds(60)).toBe(false)
  })

  test("uses the configured timeout before clearing the glasses", () => {
    let scheduledCallback: (() => void) | undefined
    let scheduledDelay: number | undefined
    globalThis.setTimeout = ((callback: () => void, delay?: number) => {
      scheduledCallback = callback
      scheduledDelay = delay
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    globalThis.clearTimeout = mock(() => {}) as unknown as typeof clearTimeout

    const clearFormatter = mock(() => {})
    const render = mock(() => Promise.resolve({status: "displayed" as const}))
    const controller = new CaptionsController({display: {render}} as never) as unknown as {
      settings: {captionTimeoutSeconds: number}
      formatter: {clear: () => void}
      lastSpeakerId: string | undefined
      resetInactivityTimer: () => void
    }
    controller.settings.captionTimeoutSeconds = 5
    controller.formatter = {clear: clearFormatter}
    controller.lastSpeakerId = "1"

    controller.resetInactivityTimer()

    expect(scheduledDelay).toBe(5000)
    expect(clearFormatter).not.toHaveBeenCalled()
    expect(render).not.toHaveBeenCalled()

    scheduledCallback?.()

    expect(clearFormatter).toHaveBeenCalledTimes(1)
    expect(render).toHaveBeenCalledWith([])
    expect(controller.lastSpeakerId).toBeUndefined()
  })

  test("preserves the existing 40-second default", () => {
    expect(DEFAULT_CAPTION_TIMEOUT_SECONDS).toBe(40)
  })
})
