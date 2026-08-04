import {describe, expect, mock, test} from "bun:test"

import {TranslationController} from "./TranslationController"

/** Mock session that captures translation handlers and glasses render text. */
function makeDisplayController() {
  let translationHandler: ((data: unknown) => void) | undefined
  let transcriptionHandler: ((data: unknown) => void) | undefined
  const renders: string[] = []
  const uiSends: Array<{channel: string; payload: Record<string, unknown>}> = []
  const storage = new Map<string, string>()
  const noop = () => () => {}
  const session = {
    translation: {
      to: (_t: string, h: (data: unknown) => void) => {
        translationHandler = h
        return () => {}
      },
    },
    transcription: {
      on: (h: (data: unknown) => void) => {
        transcriptionHandler = h
        return () => {}
      },
    },
    display: {
      render: (els: Array<{text?: string}>) => {
        if (els.length > 0 && typeof els[0].text === "string") renders.push(els[0].text)
      },
    },
    storage: {get: (k: string) => Promise.resolve(storage.get(k) ?? null), set: (k: string, v: string) => (storage.set(k, v), Promise.resolve())},
    ui: {send: (channel: string, payload: Record<string, unknown>) => uiSends.push({channel, payload}), on: noop, onOpen: noop},
    actions: {handle: noop},
    capabilities: {display: {width: 576, height: 288}},
    onCapabilitiesChange: noop,
  }
  const controller = new TranslationController(session as never) as unknown as {
    start: () => Promise<void>
    setGlassesDisplayMode: (m: string) => Promise<void>
  }
  return {
    controller,
    renders,
    uiSends,
    feed: (d: unknown) => translationHandler?.(d),
    feedTranscription: (d: unknown) => transcriptionHandler?.(d),
  }
}

function makeController() {
  const events: string[] = []
  const cleanups: Array<ReturnType<typeof mock>> = []
  const to = mock((target: string) => {
    events.push(`subscribe:${target}`)
    const cleanup = mock(() => events.push(`cleanup:${target}`))
    cleanups.push(cleanup)
    return cleanup
  })
  const controller = new TranslationController({translation: {to}} as never) as unknown as {
    settings: {targetLanguage: string}
    subscribeTranslation: () => void
  }
  return {controller, events, to, cleanups}
}

describe("TranslationController subscription replacement", () => {
  test("does not churn an unchanged target subscription", () => {
    const {controller, to, cleanups} = makeController()
    controller.subscribeTranslation()
    controller.subscribeTranslation()

    expect(to).toHaveBeenCalledTimes(1)
    expect(cleanups[0]).not.toHaveBeenCalled()
  })

  test("subscribes to the new target before releasing the old one", () => {
    const {controller, events} = makeController()
    controller.subscribeTranslation()
    controller.settings.targetLanguage = "en"
    controller.subscribeTranslation()

    expect(events).toEqual(["subscribe:es", "subscribe:en", "cleanup:es"])
  })
})

describe("TranslationController glasses display mode", () => {
  test("switching to 'both' re-renders the current line with the original text (not a no-op)", async () => {
    const {controller, renders, feed} = makeDisplayController()
    await controller.start()

    feed({text: "Hola mundo", originalText: "Hello world", isFinal: true, utteranceId: "u1", speakerId: "1"})
    const beforeToggle = renders.at(-1) ?? ""
    expect(beforeToggle).toContain("Hola mundo")
    expect(beforeToggle).not.toContain("Hello world") // default mode: translation only

    const renderCountBefore = renders.length
    await controller.setGlassesDisplayMode("both")

    // The toggle itself must produce a fresh render that now includes the
    // original transcription — the fix for the reported no-op.
    expect(renders.length).toBeGreaterThan(renderCountBefore)
    expect(renders.at(-1)).toContain("Hello world")
    expect(renders.at(-1)).toContain("Hola mundo")
  })

  test("switching back to 'translation' drops the original text from the current line", async () => {
    const {controller, renders, feed} = makeDisplayController()
    await controller.start()
    await controller.setGlassesDisplayMode("both")
    feed({text: "Bonjour", originalText: "Hello", isFinal: true, utteranceId: "u1", speakerId: "1"})
    expect(renders.at(-1)).toContain("Hello")

    await controller.setGlassesDisplayMode("translation")
    expect(renders.at(-1)).toContain("Bonjour")
    expect(renders.at(-1)).not.toContain("Hello")
  })
})

describe("TranslationController same-language passthrough (cloud events)", () => {
  // The cloud translation stream now emits speech ALREADY in the target
  // language as a transcription event whose source == target (single-detector
  // design; no second transcription subscription).
  test("same-language event shows in the UI history", async () => {
    const {controller, uiSends, feed} = makeDisplayController()
    await controller.start() // default target es

    feed({text: "Hola mundo", isFinal: true, sourceLanguage: "es", targetLanguage: "es-ES", utteranceId: "u1", speakerId: "1"})

    const card = uiSends.find(
      (s) => s.channel === "translation:live-translation" && s.payload.text === "Hola mundo",
    )
    expect(card).toBeDefined()
  })

  test("same-language reaches the glasses only in 'both' mode", async () => {
    const {controller, renders, feed} = makeDisplayController()
    await controller.start() // target es, default glasses mode "translation"

    feed({text: "Hola", isFinal: true, sourceLanguage: "es", targetLanguage: "es-ES", utteranceId: "u2"})
    expect(renders.some((r) => r.includes("Hola"))).toBe(false) // translation-only: not on glasses

    await controller.setGlassesDisplayMode("both")
    feed({text: "Adios", isFinal: true, sourceLanguage: "es-ES", targetLanguage: "es-ES", utteranceId: "u3"})
    expect(renders.some((r) => r.includes("Adios"))).toBe(true) // both: on glasses
  })

  test("cross-language events reach the glasses in every mode", async () => {
    const {controller, renders, feed} = makeDisplayController()
    await controller.start() // target es, translation-only mode

    feed({text: "Hola mundo", originalText: "Hello world", isFinal: true, sourceLanguage: "en", targetLanguage: "es-ES", utteranceId: "u4"})
    expect(renders.some((r) => r.includes("Hola mundo"))).toBe(true)
  })

  test("passthrough interims with an unidentified source do not leak onto the glasses", async () => {
    // Regression: early interims of a same-language utterance arrive before
    // Soniox has identified the language (source = "auto"/absent, and no
    // originalText since nothing is being translated). A source-vs-target
    // compare says "different" and rendered them in Translation-only mode.
    const {controller, renders, feed} = makeDisplayController()
    await controller.start() // target es, translation-only mode

    feed({text: "Hola", isFinal: false, sourceLanguage: "auto", targetLanguage: "es-ES", utteranceId: "u5"})
    feed({text: "Hola mun", isFinal: false, sourceLanguage: undefined, targetLanguage: "es-ES", utteranceId: "u5"})
    feed({text: "Hola mundo", isFinal: true, sourceLanguage: "es", targetLanguage: "es-ES", utteranceId: "u5"})

    expect(renders.some((r) => r.includes("Hola"))).toBe(false)

    // Cross-language interims (originalText present, source still unknown)
    // must STILL display in translation-only mode.
    feed({text: "Adios", originalText: "Goodbye", isFinal: false, sourceLanguage: "auto", targetLanguage: "es-ES", utteranceId: "u6"})
    expect(renders.some((r) => r.includes("Adios"))).toBe(true)
  })
})
