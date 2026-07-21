import {describe, expect, mock, test} from "bun:test"

import {TranslationController} from "./TranslationController"

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
