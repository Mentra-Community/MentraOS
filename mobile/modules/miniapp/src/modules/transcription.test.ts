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

    new TranscriptionModule(session).forLanguage("fr" as any, () => {})
    expect(subscribes).toEqual(["transcription:fr-FR"])
  })

  test("forLanguage throws on unknown values instead of subscribing", () => {
    const {session, subscribes} = mockSession()
    const mod = new TranscriptionModule(session)

    expect(() => mod.forLanguage("French" as any, () => {})).toThrow(MiniappValidationError)

    expect(() => mod.forLanguage("banana" as any, () => {})).toThrow(MiniappValidationError)
    expect(subscribes).toEqual([])
  })

  test("forLanguage suggests the fix for near-misses", () => {
    const {session} = mockSession()
    const mod = new TranscriptionModule(session)

    expect(() => mod.forLanguage("fr_FR" as any, () => {})).toThrow(/did you mean "fr-FR"/)
  })

  test("configure validates + normalizes hints and goes over sendRequest", async () => {
    const {session, requests} = mockSession()
    const mod = new TranscriptionModule(session)

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

    expect(() => mod.configure({languageHints: ["martian"] as any})).toThrow(MiniappValidationError)
    expect(requests).toEqual([])
  })
})

describe("TranslationModule language validation", () => {
  test("fromTo validates both sides and keeps auto source", () => {
    const {session, subscribes} = mockSession()
    const mod = new TranslationModule(session)
    mod.fromTo("auto", "en-US", () => {})

    mod.fromTo("zh" as any, "en-US", () => {})
    expect(subscribes).toEqual(["translation:auto:en-US", "translation:zh-CN:en-US"])
  })

  test("to throws on invalid targets", () => {
    const {session, subscribes} = mockSession()
    const mod = new TranslationModule(session)

    expect(() => mod.to("Chinese" as any, () => {})).toThrow(MiniappValidationError)
    expect(subscribes).toEqual([])
  })
})

describe("TranscriptionModule on-device model status", () => {
  function statusSession() {
    const handlers = new Map<string, (data: unknown) => void>()
    let subscribeCalls = 0
    let unsubscribeCalls = 0
    const session = {
      _subscribe: (stream: string, handler: (data: unknown) => void) => {
        subscribeCalls++
        handlers.set(stream, handler)
        return () => {
          unsubscribeCalls++
          handlers.delete(stream)
        }
      },
    } as unknown as MiniappSession
    return {
      session,
      emit: (data: unknown) => handlers.get("transcription_model_status")?.(data),
      counts: () => ({subscribeCalls, unsubscribeCalls}),
    }
  }

  test("shares one subscription and replays the last state to later handlers", async () => {
    const {session, emit, counts} = statusSession()
    const mod = new TranscriptionModule(session)
    const first: unknown[] = []
    const second: unknown[] = []
    const offFirst = mod.onModelStatus((status) => first.push(status))
    emit({language: "en-US", state: "downloading", progress: 40})
    const offSecond = mod.onModelStatus((status) => second.push(status))
    expect(second).toEqual([])
    await Promise.resolve()
    expect(second).toEqual([{language: "en-US", state: "downloading", progress: 40}])
    emit({language: "en-US", state: "ready"})
    expect(first).toEqual([
      {language: "en-US", state: "downloading", progress: 40},
      {language: "en-US", state: "ready"},
    ])
    expect(second.at(-1)).toEqual({language: "en-US", state: "ready"})
    expect(counts().subscribeCalls).toBe(1)
    offFirst()
    expect(counts().unsubscribeCalls).toBe(0)
    offSecond()
    expect(counts().unsubscribeCalls).toBe(1)
  })

  test("stop() releases the status subscription", () => {
    const {session, counts} = statusSession()
    const mod = new TranscriptionModule(session)
    mod.onModelStatus(() => {})
    mod.stop()
    expect(counts().unsubscribeCalls).toBe(1)
  })
})

describe("TranscriptionModule.finishUtterance", () => {
  test("resolves with the host's final text or null", async () => {
    const results: Array<string | null> = ["what time is it", null]
    const requests: Array<Record<string, unknown>> = []
    const session = {
      sendRequest: async (payload: Record<string, unknown>) => {
        requests.push(payload)
        return results.shift()
      },
    } as unknown as MiniappSession
    const mod = new TranscriptionModule(session)
    expect(await mod.finishUtterance()).toBe("what time is it")
    expect(await mod.finishUtterance()).toBeNull()
    expect(requests).toEqual([
      {type: MiniappRequestType.TRANSCRIPTION_FINISH},
      {type: MiniappRequestType.TRANSCRIPTION_FINISH},
    ])
  })
})
