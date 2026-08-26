import {afterEach, describe, expect, mock, test} from "bun:test"

import {G2_PROFILE, NEX_PROFILE} from "../../core/CaptionsFormatter"
import {DEFAULT_CAPTION_TIMEOUT_SECONDS} from "../../shared/types"
import {calculateCaptionBox, CaptionsController, isSupportedCaptionTimeoutSeconds} from "./CaptionsController"

describe("CaptionsController caption position", () => {
  test("selects the connected G2 profile after CONNECT_ACK readiness", async () => {
    const session = {
      capabilities: null as Record<string, unknown> | null,
      ui: {
        send: mock(() => undefined),
        on: mock(() => () => undefined),
        onOpen: mock(() => () => undefined),
      },
      onCapabilitiesChange: mock(() => () => undefined),
      waitForReady: mock(async () => {
        session.capabilities = {
          modelName: "Even Realities G2",
          display: {width: 576, height: 288, canPosition: true, maxTextLines: 8},
        }
      }),
      storage: {get: mock(() => Promise.resolve(null))},
      transcription: {on: mock(() => () => undefined)},
      cloud: {onStatusChanged: mock(() => () => undefined)},
      display: {render: mock(() => Promise.resolve({status: "rendered"}))},
    }
    const controller = new CaptionsController(session as never) as unknown as {
      currentProfile: {id: string; lineHeightPx?: number}
      start: () => Promise<void>
    }

    await controller.start()

    expect(session.waitForReady).toHaveBeenCalledTimes(1)
    expect(controller.currentProfile).toMatchObject({id: "even-realities-g2", lineHeightPx: 40})
  })

  test("anchors a fixed three-line G2 band at the top or bottom", () => {
    const base = {
      canvasWidth: 576,
      canvasHeight: 288,
      canPosition: true,
      lineCount: 3,
      maxTextLines: 8,
      lineHeightPx: 40,
    }

    expect(calculateCaptionBox({...base, position: "top"})).toEqual({x: 0, y: 0, w: 576, h: 120})
    expect(calculateCaptionBox({...base, position: "bottom"})).toEqual({x: 0, y: 168, w: 576, h: 120})
  })

  test("keeps a full-canvas text wall when positioning is unsupported", () => {
    expect(
      calculateCaptionBox({
        canvasWidth: 576,
        canvasHeight: 288,
        canPosition: false,
        position: "bottom",
        lineCount: 3,
        lineHeightPx: 40,
      }),
    ).toEqual({x: 0, y: 0, w: 576, h: 288})
  })

  test("infers a line height when the device has no calibrated profile", () => {
    expect(
      calculateCaptionBox({
        canvasWidth: 500,
        canvasHeight: 220,
        canPosition: true,
        position: "bottom",
        lineCount: 3,
        maxTextLines: 5,
      }),
    ).toEqual({x: 0, y: 88, w: 500, h: 132})
  })

  test("keeps five-line Mentra Display captions positionable", () => {
    expect(
      calculateCaptionBox({
        canvasWidth: 500,
        canvasHeight: 220,
        canPosition: true,
        position: "bottom",
        lineCount: 5,
        maxTextLines: 5,
        lineHeightPx: NEX_PROFILE.lineHeightPx,
      }),
    ).toEqual({x: 0, y: 85, w: 500, h: 135})
  })

  test("re-renders the active interim when its position changes", async () => {
    const render = mock(() => Promise.resolve({status: "rendered"}))
    const controller = new CaptionsController({
      capabilities: {display: {width: 576, height: 288, canPosition: true, maxTextLines: 8}},
      display: {render},
      storage: {set: mock(() => Promise.resolve())},
    } as never) as unknown as {
      currentDisplayText: string
      currentMaxLines: number
      currentProfile: typeof G2_PROFILE
      settings: {captionPosition: string}
      ui: {send: ReturnType<typeof mock>}
      setCaptionPosition: (position: "top" | "bottom") => Promise<void>
    }
    controller.currentDisplayText = "live interim words"
    controller.currentMaxLines = 3
    controller.currentProfile = G2_PROFILE
    controller.ui = {send: mock(() => undefined)}

    await controller.setCaptionPosition("bottom")

    expect(render).toHaveBeenCalledWith([
      {type: "text", id: "caption", box: {x: 0, y: 168, w: 576, h: 120}, text: "live interim words"},
    ])
    expect(controller.settings.captionPosition).toBe("bottom")
  })

  test("preserves an active interim when capabilities refresh", () => {
    const render = mock(() => Promise.resolve({status: "rendered"}))
    const controller = new CaptionsController({
      capabilities: {display: {width: 600, height: 300, canPosition: true, maxTextLines: 8}},
      display: {render},
    } as never) as unknown as {
      activeInterim: {text: string; speakerId?: string; speakerChanged: boolean}
      createFormatter: () => void
      currentDisplayText: string
      currentMaxLines: number
      currentProfile: typeof G2_PROFILE
      lastDisplayPreview: {text: string; lines: string[]; isFinal: boolean; timestamp: number}
      settings: {captionPosition: "top" | "bottom"}
      ui: {send: ReturnType<typeof mock>}
      refreshDisplay: () => void
    }
    controller.activeInterim = {text: "one\ntwo\nthree\nfour\nfive", speakerChanged: false}
    controller.currentDisplayText = "one\ntwo\nthree\nfour\nfive"
    controller.currentMaxLines = 2
    controller.currentProfile = G2_PROFILE
    controller.createFormatter()
    controller.lastDisplayPreview = {
      text: "one\ntwo\nthree\nfour\nfive",
      lines: ["one", "two", "three", "four", "five"],
      isFinal: false,
      timestamp: Date.now(),
    }
    controller.settings.captionPosition = "bottom"
    controller.ui = {send: mock(() => undefined)}

    controller.refreshDisplay()

    expect(render).toHaveBeenCalledWith([
      {type: "text", id: "caption", box: {x: 0, y: 220, w: 600, h: 80}, text: "four\nfive"},
    ])
    expect(controller.lastDisplayPreview).toMatchObject({text: "four\nfive", isFinal: false})
  })

  test("restores bottom and defaults unknown stored values to top", async () => {
    const bottomController = new CaptionsController({
      storage: {get: mock((key: string) => Promise.resolve(key === "captionPosition" ? "bottom" : null))},
    } as never) as unknown as {
      settings: {captionPosition: string}
      loadSettings: () => Promise<void>
    }
    await bottomController.loadSettings()
    expect(bottomController.settings.captionPosition).toBe("bottom")

    const invalidController = new CaptionsController({
      storage: {get: mock((key: string) => Promise.resolve(key === "captionPosition" ? "middle" : null))},
    } as never) as unknown as {
      settings: {captionPosition: string}
      loadSettings: () => Promise<void>
    }
    await invalidController.loadSettings()
    expect(invalidController.settings.captionPosition).toBe("top")
  })
})

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

describe("CaptionsController offline speech to text", () => {
  test("restores the persisted setting", async () => {
    const get = mock((key: string) => Promise.resolve(key === "useOfflineStt" ? "true" : null))
    const controller = new CaptionsController({
      storage: {get},
    } as never) as unknown as {
      settings: {useOfflineStt: boolean}
      loadSettings: () => Promise<void>
    }

    await controller.loadSettings()

    expect(controller.settings.useOfflineStt).toBe(true)
  })

  test("persists the setting and rebuilds the subscription with forceLocal", async () => {
    const previousCleanup = mock(() => {})
    const nextCleanup = mock(() => {})
    const on = mock((_handler: (data: unknown) => void, _options?: {forceLocal?: boolean}) => nextCleanup)
    const set = mock(() => Promise.resolve())
    const send = mock(() => {})

    const controller = new CaptionsController({
      storage: {set},
      transcription: {
        configure: mock(() => Promise.resolve()),
        on,
      },
    } as never) as unknown as {
      settings: {useOfflineStt: boolean}
      ui: {send: typeof send}
      transcriptionCleanup: () => void
      setUseOfflineStt: (enabled: boolean) => Promise<void>
    }
    controller.ui = {send}
    controller.transcriptionCleanup = previousCleanup

    await controller.setUseOfflineStt(true)

    expect(previousCleanup).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith("useOfflineStt", "true")
    expect(on).toHaveBeenCalledTimes(1)
    expect(on.mock.calls[0]?.[1]).toEqual({forceLocal: true})
    expect(send).toHaveBeenCalledWith("captions:settings-update", expect.objectContaining({useOfflineStt: true}))
  })

  test("returns to cloud transcription when the setting is disabled", async () => {
    const on = mock((_handler: (data: unknown) => void, _options?: {forceLocal?: boolean}) => mock(() => {}))
    const controller = new CaptionsController({
      storage: {set: mock(() => Promise.resolve())},
      transcription: {
        configure: mock(() => Promise.resolve()),
        on,
      },
    } as never) as unknown as {
      settings: {useOfflineStt: boolean}
      ui: {send: () => void}
      setUseOfflineStt: (enabled: boolean) => Promise<void>
    }
    controller.settings.useOfflineStt = true
    controller.ui = {send: mock(() => {})}

    await controller.setUseOfflineStt(false)

    expect(on).toHaveBeenCalledTimes(1)
    expect(on.mock.calls[0]?.[1]).toEqual({})
  })

  test("uses the local model for a selected language", () => {
    const forLanguage = mock(
      (_language: string, _handler: (data: unknown) => void, _options?: {forceLocal?: boolean}) => mock(() => {}),
    )
    const controller = new CaptionsController({
      transcription: {
        configure: mock(() => Promise.resolve()),
        forLanguage,
      },
    } as never) as unknown as {
      settings: {
        language: string
        languageHints: string[]
        useOfflineStt: boolean
      }
      subscribeTranscription: () => void
    }
    controller.settings.language = "fr-FR"
    controller.settings.languageHints = []
    controller.settings.useOfflineStt = true

    controller.subscribeTranscription()

    expect(forLanguage).toHaveBeenCalledTimes(1)
    expect(forLanguage.mock.calls[0]?.[0]).toBe("fr-FR")
    expect(forLanguage.mock.calls[0]?.[2]).toEqual({forceLocal: true})
  })
})
