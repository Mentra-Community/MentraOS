/// <reference types="bun-types" />

/**
 * Language validation at the SDK boundary (issue 021 WP2). Pins that:
 *   - invalid languages THROW, never become subscriptions
 *   - bare registry codes canonicalize before hitting the stream key
 *   - configure() validates + normalizes hints and uses sendRequest
 */
import {describe, expect, test} from "bun:test"

import {MiniappRequestType} from "../protocol"
import type {MiniappSession} from "../session"
import {MiniappValidationError} from "./languages"
import {TranscriptionModule} from "./transcription"
import {TranslationModule} from "./translation"

function mockSession() {
  const subscribes: string[] = []
  const requests: Array<Record<string, unknown>> = []
  const session = {
    _subscribe: (stream: string) => {
      subscribes.push(stream)
      return () => {}
    },
    sendOneShot: () => {
      throw new Error("configure must use sendRequest, not a one-shot (issue 021 S3)")
    },
    sendRequest: (payload: Record<string, unknown>) => {
      requests.push(payload)
      return Promise.resolve(undefined)
    },
  } as unknown as MiniappSession
  return {session, subscribes, requests}
}

describe("TranscriptionModule language validation", () => {
  test("forLanguage passes registry tags through", () => {
    const {session, subscribes} = mockSession()
    new TranscriptionModule(session).forLanguage("en-US", () => {})
    expect(subscribes).toEqual(["transcription:en-US"])
  })

  test("forLanguage canonicalizes bare registry codes", () => {
    const {session, subscribes} = mockSession()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new TranscriptionModule(session).forLanguage("fr" as any, () => {})
    expect(subscribes).toEqual(["transcription:fr-FR"])
  })

  test("forLanguage throws on unknown values instead of subscribing", () => {
    const {session, subscribes} = mockSession()
    const mod = new TranscriptionModule(session)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => mod.forLanguage("French" as any, () => {})).toThrow(MiniappValidationError)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => mod.forLanguage("banana" as any, () => {})).toThrow(MiniappValidationError)
    expect(subscribes).toEqual([])
  })

  test("forLanguage suggests the fix for near-misses", () => {
    const {session} = mockSession()
    const mod = new TranscriptionModule(session)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => mod.forLanguage("fr_FR" as any, () => {})).toThrow(/did you mean "fr-FR"/)
  })

  test("configure validates + normalizes hints and goes over sendRequest", async () => {
    const {session, requests} = mockSession()
    const mod = new TranscriptionModule(session)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mod.configure({languageHints: ["en-US", "fr"] as any})
    expect(requests).toEqual([
      {
        type: MiniappRequestType.TRANSCRIPTION_CONFIG,
        config: {languageHints: ["en", "fr"]},
      },
    ])
  })

  test("configure throws synchronously on unknown hints", () => {
    const {session, requests} = mockSession()
    const mod = new TranscriptionModule(session)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => mod.configure({languageHints: ["martian"] as any})).toThrow(MiniappValidationError)
    expect(requests).toEqual([])
  })
})

describe("TranslationModule language validation", () => {
  test("fromTo validates both sides and keeps auto source", () => {
    const {session, subscribes} = mockSession()
    const mod = new TranslationModule(session)
    mod.fromTo("auto", "en-US", () => {})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.fromTo("zh" as any, "en-US", () => {})
    expect(subscribes).toEqual(["translation:auto:en-US", "translation:zh-CN:en-US"])
  })

  test("to throws on invalid targets", () => {
    const {session, subscribes} = mockSession()
    const mod = new TranslationModule(session)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => mod.to("Chinese" as any, () => {})).toThrow(MiniappValidationError)
    expect(subscribes).toEqual([])
  })
})
