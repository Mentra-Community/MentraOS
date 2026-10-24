/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, test} from "bun:test"

import type {DeclaredAge} from "@mentra/cloud-protocol/declared-age"

import {configure, resetForTests, type AgeRestrictionNotice} from "../../runtime/bootstrap"
import {
  checkMiniappAge,
  createMiniappAgeGate,
  displayedRating,
  hostMinimumAge,
  miniappRequiredAge,
  ratingMinimumAge,
  setMiniappAgeGateDependenciesForTests,
  type MiniappAgeGateDependencies,
} from "../miniappAgeGate"

const ANSWERED_AT = "2026-10-24T08:00:00.000Z"
const notes = {packageName: "com.example.notes", name: "Notes"}

let hostRating: string | null | undefined
let account: () => Promise<string | null>
/** What Core keeps, per account. */
let core: Map<string, DeclaredAge>
/** This phone's copy. */
let phone: {account: string; declared: DeclaredAge} | null
let coreDown: boolean
let storeFails: boolean
let answers: Array<number | null>
let canAsk: boolean
let now: Date
let calls: string[]
let warnings: string[]

function deps(overrides: Partial<MiniappAgeGateDependencies> = {}): MiniappAgeGateDependencies {
  return {
    hostAgeRating: () => hostRating,
    account: () => account(),
    cached: (who) => (phone?.account === who ? phone.declared : null),
    cache: (who, declared) => {
      calls.push(`cache ${who}`)
      phone = {account: who, declared}
    },
    fetch: async (who) => {
      calls.push(`fetch ${who}`)
      if (coreDown) throw new Error("offline")
      return core.get(who) ?? {declaredAge: null, declaredAgeAt: null}
    },
    store: async (who, age) => {
      calls.push(`store ${who} ${age}`)
      if (storeFails) throw new Error("offline")
      const kept = {declaredAge: age, declaredAgeAt: now.toISOString()}
      core.set(who, kept)
      return kept
    },
    asker: () =>
      canAsk
        ? async () => {
            calls.push("ask")
            return answers.length ? answers.shift()! : null
          }
        : null,
    now: () => now,
    warn: (message) => warnings.push(message),
    ...overrides,
  }
}

beforeEach(() => {
  hostRating = "12+"
  account = async () => "mu_alice"
  core = new Map()
  phone = null
  coreDown = false
  storeFails = false
  answers = []
  canAsk = true
  now = new Date(ANSWERED_AT)
  calls = []
  warnings = []
})

describe("ratings", () => {
  test("Apple's categories name their minimum age; anything else declared counts as 18+", () => {
    expect([ratingMinimumAge("4+"), ratingMinimumAge("9+"), ratingMinimumAge("13+"), ratingMinimumAge("16+")]).toEqual([
      4, 9, 13, 16,
    ])
    expect(ratingMinimumAge("18+")).toBe(18)
    expect(ratingMinimumAge("21+")).toBe(18)
    expect(ratingMinimumAge("PG-13")).toBe(18)
    expect(ratingMinimumAge(13)).toBe(18)
    expect(ratingMinimumAge(undefined)).toBeNull()
    expect(ratingMinimumAge(null)).toBeNull()
    expect(displayedRating("16+")).toBe("16+")
    expect(displayedRating("PG-13")).toBe("18+")
  })

  test("the host's own rating is read as App Store Connect writes it; an unreadable one counts as 4+", () => {
    expect(hostMinimumAge("12+")).toBe(12)
    expect(hostMinimumAge("17+")).toBe(17)
    expect(hostMinimumAge("twelve")).toBe(4)
    expect(hostMinimumAge(undefined)).toBeNull()
    expect(hostMinimumAge(null)).toBeNull()
  })

  test("only a rating above the host's needs an age", () => {
    const gate = createMiniappAgeGate(deps())
    expect([gate.requiredAge(undefined), gate.requiredAge("4+"), gate.requiredAge("9+")]).toEqual([null, null, null])
    expect([gate.requiredAge("13+"), gate.requiredAge("16+"), gate.requiredAge("18+")]).toEqual([13, 16, 18])
    hostRating = undefined
    expect(gate.requiredAge("18+")).toBeNull()
  })
})

describe("the gate", () => {
  test("a miniapp without a rating is never gated, and nobody is asked or looked up", async () => {
    const gate = createMiniappAgeGate(deps())
    expect(await gate.check({...notes, ageRating: undefined}, {ask: true})).toBe("allowed")
    expect(await gate.check({...notes, ageRating: null}, {ask: true})).toBe("allowed")
    expect(calls).toEqual([])
  })

  test("a rating at or below the host's is never gated", async () => {
    const gate = createMiniappAgeGate(deps())
    for (const ageRating of ["4+", "9+"]) expect(await gate.check({...notes, ageRating}, {ask: true})).toBe("allowed")
    expect(calls).toEqual([])
  })

  test("a host with no rating of its own gates nothing", async () => {
    hostRating = undefined
    expect(await createMiniappAgeGate(deps()).check({...notes, ageRating: "18+"}, {ask: true})).toBe("allowed")
    expect(calls).toEqual([])
  })

  test("a rating above the host's needs the person's declared age to be old enough", async () => {
    core.set("mu_alice", {declaredAge: 15, declaredAgeAt: ANSWERED_AT})
    const gate = createMiniappAgeGate(deps())
    expect(await gate.check({...notes, ageRating: "13+"}, {ask: true})).toBe("allowed")
    expect(await gate.check({...notes, ageRating: "16+"}, {ask: true})).toBe("too_young")
    expect(await gate.check({...notes, ageRating: "18+"}, {ask: true})).toBe("too_young")
    expect(calls).not.toContain("ask")
  })

  test("the age grows with time: a year after answering 15, 16+ opens", async () => {
    core.set("mu_alice", {declaredAge: 15, declaredAgeAt: ANSWERED_AT})
    const gate = createMiniappAgeGate(deps())
    now = new Date("2027-10-23T23:00:00.000Z")
    expect(await gate.check({...notes, ageRating: "16+"}, {ask: false})).toBe("too_young")
    now = new Date("2027-10-24T00:00:00.000Z")
    expect(await gate.check({...notes, ageRating: "16+"}, {ask: false})).toBe("allowed")
  })

  test("the first time, the person is asked once; the answer is kept on the account and on this phone", async () => {
    answers = [17]
    const gate = createMiniappAgeGate(deps())
    expect(await gate.check({...notes, ageRating: "16+"}, {ask: true})).toBe("allowed")
    expect(calls).toEqual(["fetch mu_alice", "ask", "store mu_alice 17", "cache mu_alice"])
    expect(core.get("mu_alice")).toEqual({declaredAge: 17, declaredAgeAt: ANSWERED_AT})

    calls = []
    expect(await gate.check({...notes, ageRating: "18+"}, {ask: true})).toBe("too_young")
    expect(calls).toEqual([])
  })

  test("an age already on the account is used without asking, and kept on this phone", async () => {
    core.set("mu_alice", {declaredAge: 30, declaredAgeAt: ANSWERED_AT})
    const gate = createMiniappAgeGate(deps())
    expect(await gate.check({...notes, ageRating: "18+"}, {ask: true})).toBe("allowed")
    expect(calls).toEqual(["fetch mu_alice", "cache mu_alice"])
    calls = []
    coreDown = true
    expect(await gate.check({...notes, ageRating: "18+"}, {ask: false})).toBe("allowed")
    expect(calls).toEqual([])
  })

  test("checks waiting at once share one question", async () => {
    let answer!: (age: number | null) => void
    const gate = createMiniappAgeGate(
      deps({
        asker: () => () => {
          calls.push("ask")
          return new Promise((resolve) => (answer = resolve))
        },
      }),
    )
    const first = gate.check({...notes, ageRating: "16+"}, {ask: true})
    const second = gate.check({...notes, packageName: "com.example.other", ageRating: "18+"}, {ask: true})
    await Bun.sleep(0)
    answer(16)
    expect(await Promise.all([first, second])).toEqual(["allowed", "too_young"])
    expect(calls.filter((call) => call === "ask")).toHaveLength(1)
    expect(calls.filter((call) => call.startsWith("store"))).toEqual(["store mu_alice 16"])
  })

  test("a read of Core that comes back empty after another check's answer was kept doesn't ask again", async () => {
    let releaseSlowRead!: () => void
    let reads = 0
    const gate = createMiniappAgeGate(
      deps({
        fetch: async (who) => {
          reads += 1
          calls.push(`fetch ${who}`)
          // The first read started before the person answered, and Core's empty answer lands only afterwards.
          if (reads === 1) await new Promise<void>((resolve) => (releaseSlowRead = resolve))
          return {declaredAge: null, declaredAgeAt: null}
        },
      }),
    )
    answers = [17, 30]
    const slow = gate.check({...notes, ageRating: "18+"}, {ask: true})
    await Bun.sleep(0)
    expect(await gate.check({...notes, ageRating: "16+"}, {ask: true})).toBe("allowed")
    releaseSlowRead()
    expect(await slow).toBe("too_young")
    expect(calls.filter((call) => call === "ask")).toHaveLength(1)
    expect(core.get("mu_alice")).toEqual({declaredAge: 17, declaredAgeAt: ANSWERED_AT})
  })

  test("closing the question is cancelled, keeps nothing, and the next check asks again", async () => {
    answers = [null, 20]
    const gate = createMiniappAgeGate(deps())
    expect(await gate.check({...notes, ageRating: "18+"}, {ask: true})).toBe("cancelled")
    expect(core.size).toBe(0)
    expect(phone).toBeNull()
    expect(await gate.check({...notes, ageRating: "18+"}, {ask: true})).toBe("allowed")
  })

  test("an answer that isn't an age is treated as closing the question", async () => {
    const gate = createMiniappAgeGate(deps({asker: () => async () => 12.5}))
    expect(await gate.check({...notes, ageRating: "18+"}, {ask: true})).toBe("cancelled")
    expect(core.size).toBe(0)
  })

  test("a check that may not ask (the miniapp starting without the person) is unknown until an age is declared", async () => {
    answers = [40]
    const gate = createMiniappAgeGate(deps())
    expect(await gate.check({...notes, ageRating: "18+"}, {ask: false})).toBe("unknown")
    expect(calls).not.toContain("ask")
  })

  test("a host that can't ask is unknown", async () => {
    canAsk = false
    expect(await createMiniappAgeGate(deps()).check({...notes, ageRating: "18+"}, {ask: true})).toBe("unknown")
  })

  test("nobody signed in is unknown; an account not known yet is unavailable", async () => {
    account = async () => null
    expect(await createMiniappAgeGate(deps()).check({...notes, ageRating: "18+"}, {ask: true})).toBe("unknown")
    account = async () => {
      throw new Error("offline")
    }
    expect(await createMiniappAgeGate(deps()).check({...notes, ageRating: "18+"}, {ask: true})).toBe("unavailable")
    expect(calls).toEqual([])
  })

  test("Core out of reach, with nothing on this phone, is unavailable and asks nothing", async () => {
    coreDown = true
    answers = [40]
    expect(await createMiniappAgeGate(deps()).check({...notes, ageRating: "18+"}, {ask: true})).toBe("unavailable")
    expect(calls).toEqual(["fetch mu_alice"])
  })

  test("an answer Core couldn't keep is unavailable, and isn't kept on this phone either", async () => {
    storeFails = true
    answers = [40]
    expect(await createMiniappAgeGate(deps()).check({...notes, ageRating: "18+"}, {ask: true})).toBe("unavailable")
    expect(phone).toBeNull()
  })

  test("this phone's copy is one account's: another account is looked up and asked for its own", async () => {
    phone = {account: "mu_alice", declared: {declaredAge: 40, declaredAgeAt: ANSWERED_AT}}
    account = async () => "mu_bob"
    answers = [10]
    expect(await createMiniappAgeGate(deps()).check({...notes, ageRating: "13+"}, {ask: true})).toBe("too_young")
    expect(calls).toEqual(["fetch mu_bob", "ask", "store mu_bob 10", "cache mu_bob"])
    expect(phone).toEqual({account: "mu_bob", declared: {declaredAge: 10, declaredAgeAt: ANSWERED_AT}})
  })
})

describe("the engine's check", () => {
  let notices: AgeRestrictionNotice[]

  beforeEach(() => {
    notices = []
    configure({
      auth: {},
      config: {hostAgeRating: "12+"},
      ui: {showAgeRestricted: (notice) => notices.push(notice)},
    })
    setMiniappAgeGateDependenciesForTests(deps({hostAgeRating: () => "12+"}))
  })

  afterEach(() => {
    setMiniappAgeGateDependenciesForTests(null)
    resetForTests()
  })

  test("tells a person in front of the app why it stopped", async () => {
    core.set("mu_alice", {declaredAge: 14, declaredAgeAt: ANSWERED_AT})
    expect(await checkMiniappAge({...notes, ageRating: "16+"}, {interactive: true})).toBe("too_young")
    coreDown = true
    phone = null
    expect(await checkMiniappAge({...notes, ageRating: "PG"}, {interactive: true})).toBe("unavailable")
    expect(notices).toEqual([
      {packageName: "com.example.notes", name: "Notes", ageRating: "16+", reason: "too_young"},
      {packageName: "com.example.notes", name: "Notes", ageRating: "18+", reason: "unavailable"},
    ])
  })

  test("tells nobody when the miniapp starts without the person, or the person closed the question", async () => {
    core.set("mu_alice", {declaredAge: 14, declaredAgeAt: ANSWERED_AT})
    expect(await checkMiniappAge({...notes, ageRating: "16+"}, {interactive: false})).toBe("too_young")
    core.clear()
    phone = null
    answers = [null]
    expect(await checkMiniappAge({...notes, ageRating: "16+"}, {interactive: true})).toBe("cancelled")
    expect(notices).toEqual([])
  })

  test("its own gate reads the host's rating from the engine's configuration", () => {
    setMiniappAgeGateDependenciesForTests(null)
    expect(miniappRequiredAge("13+")).toBe(13)
    expect(miniappRequiredAge("9+")).toBeNull()
  })
})
