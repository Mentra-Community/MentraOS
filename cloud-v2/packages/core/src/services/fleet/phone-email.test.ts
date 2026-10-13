import {afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test} from "bun:test"
import * as trustedEmail from "../account/trusted-email.service"
import {PHONE_EMAIL_CACHE_MAX, phoneEmail, resetPhoneEmailCache} from "./phone-email"

const MINUTE = 60_000

let lookup: ReturnType<typeof spyOn<typeof trustedEmail, "trustedAccountEmail">>

beforeEach(() => {
  resetPhoneEmailCache()
  setSystemTime(new Date("2026-10-13T12:00:00Z"))
  lookup = spyOn(trustedEmail, "trustedAccountEmail").mockResolvedValue("person@example.test")
})

afterEach(() => {
  lookup.mockRestore()
  setSystemTime()
  resetPhoneEmailCache()
})

describe("the phone principal's email", () => {
  test("is the account's verified email, and null when the account has none", async () => {
    expect(await phoneEmail("mu_verified")).toBe("person@example.test")
    lookup.mockResolvedValue(null)
    expect(await phoneEmail("mu_unverified")).toBeNull()
  })

  test("is looked up once per person while it is fresh, and again after five minutes", async () => {
    await phoneEmail("mu_a")
    await phoneEmail("mu_a")
    await phoneEmail("mu_b")
    expect(lookup).toHaveBeenCalledTimes(2)

    setSystemTime(new Date(Date.now() + 5 * MINUTE - 1))
    await phoneEmail("mu_a")
    expect(lookup).toHaveBeenCalledTimes(2)

    setSystemTime(new Date(Date.now() + 2))
    await phoneEmail("mu_a")
    expect(lookup).toHaveBeenCalledTimes(3)
  })

  test("a missing email is remembered too, so an unverified account costs one lookup", async () => {
    lookup.mockResolvedValue(null)

    expect(await phoneEmail("mu_unverified")).toBeNull()
    expect(await phoneEmail("mu_unverified")).toBeNull()

    expect(lookup).toHaveBeenCalledTimes(1)
  })

  test("a failing lookup is null rather than an error, and is retried after thirty seconds", async () => {
    lookup.mockRejectedValue(new Error("account directory unavailable"))

    expect(await phoneEmail("mu_a")).toBeNull()
    expect(await phoneEmail("mu_a")).toBeNull()
    expect(lookup).toHaveBeenCalledTimes(1)

    lookup.mockResolvedValue("person@example.test")
    setSystemTime(new Date(Date.now() + 30_001))
    expect(await phoneEmail("mu_a")).toBe("person@example.test")
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  test("a lookup that does not answer by the deadline is cancelled and is null", async () => {
    let signal: AbortSignal | undefined
    lookup.mockImplementation((_id, options) => {
      signal = options?.signal
      return new Promise<string | null>(() => {})
    })

    const started = performance.now()
    expect(await phoneEmail("mu_slow", {timeoutMs: 25})).toBeNull()

    expect(performance.now() - started).toBeLessThan(2000)
    expect(signal?.aborted).toBe(true)
  })

  test("remembers at most PHONE_EMAIL_CACHE_MAX people, forgetting the oldest first", async () => {
    for (let i = 0; i < PHONE_EMAIL_CACHE_MAX; i++) await phoneEmail(`mu_${i}`)
    expect(lookup).toHaveBeenCalledTimes(PHONE_EMAIL_CACHE_MAX)

    await phoneEmail("mu_0")
    expect(lookup).toHaveBeenCalledTimes(PHONE_EMAIL_CACHE_MAX)

    await phoneEmail("mu_new")
    expect(lookup).toHaveBeenCalledTimes(PHONE_EMAIL_CACHE_MAX + 1)
    // mu_1 was the oldest, so it is the one that went; mu_0 was used again and stayed.
    await phoneEmail("mu_0")
    expect(lookup).toHaveBeenCalledTimes(PHONE_EMAIL_CACHE_MAX + 1)
    await phoneEmail("mu_1")
    expect(lookup).toHaveBeenCalledTimes(PHONE_EMAIL_CACHE_MAX + 2)
  })
})
