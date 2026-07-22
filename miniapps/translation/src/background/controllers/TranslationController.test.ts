import {describe, expect, mock, test} from "bun:test"

import {TranslationController} from "./TranslationController"

/** Mock session that captures translation handlers and glasses render text. */
function makeDisplayController() {
  let translationHandler: ((data: unknown) => void) | undefined
  const renders: string[] = []
  const storage = new Map<string, string>()
  const noop = () => () => {}
  const session = {
    translation: {
      to: (_t: string, h: (data: unknown) => void) => {
        translationHandler = h
        return () => {}
      },
    },
    display: {
      render: (els: Array<{text?: string}>) => {
        if (els.length > 0 && typeof els[0].text === "string") renders.push(els[0].text)
      },
    },
    storage: {get: (k: string) => Promise.resolve(storage.get(k) ?? null), set: (k: string, v: string) => (storage.set(k, v), Promise.resolve())},
    ui: {send: () => {}, on: noop, onOpen: noop},
    actions: {handle: noop},
    capabilities: {display: {width: 576, height: 288}},
    onCapabilitiesChange: noop,
  }
  const controller = new TranslationController(session as never) as unknown as {
    start: () => Promise<void>
    setGlassesDisplayMode: (m: string) => Promise<void>
  }
  return {controller, renders, feed: (d: unknown) => translationHandler?.(d)}
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
