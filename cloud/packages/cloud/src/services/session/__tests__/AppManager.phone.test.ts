/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"
import { PHONE_PACKAGE_NAME } from "../PhoneSession"

describe("PHONE_PACKAGE_NAME constant", () => {
  test("is __phone__", () => {
    expect(PHONE_PACKAGE_NAME).toBe("__phone__")
  })
})

describe("PhoneSession", () => {
  // These are basic structural tests since full AppManager tests require
  // a UserSession with a real WebSocket connection

  test("can be imported", async () => {
    const { PhoneSession } = await import("../PhoneSession")
    expect(PhoneSession).toBeDefined()
  })

  test("packageName is __phone__", async () => {
    const { PhoneSession } = await import("../PhoneSession")
    const pino = await import("pino")
    const logger = pino.default({ level: "silent" })
    const session = new PhoneSession(logger)
    expect(session.packageName).toBe("__phone__")
  })

  test("starts with empty subscriptions", async () => {
    const { PhoneSession } = await import("../PhoneSession")
    const pino = await import("pino")
    const logger = pino.default({ level: "silent" })
    const session = new PhoneSession(logger)
    expect(session.subscriptions.size).toBe(0)
    expect(session.getSubscriptions()).toEqual([])
  })

  test("updateSubscriptions stores them", async () => {
    const { PhoneSession } = await import("../PhoneSession")
    const pino = await import("pino")
    const logger = pino.default({ level: "silent" })
    const session = new PhoneSession(logger)
    const result = session.updateSubscriptions(["transcription:en-US", "button_press"] as any[])
    expect(result.applied).toBe(true)
    expect(session.subscriptions.size).toBe(2)
    expect(session.hasSubscription("transcription:en-US" as any)).toBe(true)
  })

  test("enqueue runs operation immediately", async () => {
    const { PhoneSession } = await import("../PhoneSession")
    const pino = await import("pino")
    const logger = pino.default({ level: "silent" })
    const session = new PhoneSession(logger)
    const result = await session.enqueue(async () => 42)
    expect(result).toBe(42)
  })

  test("cleanup clears subscriptions", async () => {
    const { PhoneSession } = await import("../PhoneSession")
    const pino = await import("pino")
    const logger = pino.default({ level: "silent" })
    const session = new PhoneSession(logger)
    session.updateSubscriptions(["transcription:en-US"] as any[])
    session.cleanup()
    expect(session.subscriptions.size).toBe(0)
    expect(session.isDisposed).toBe(true)
  })
})
