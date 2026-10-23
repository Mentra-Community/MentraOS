import {describe, expect, test} from "bun:test"

import {RecentChecks} from "./recent-checks"

const MINUTE = 60_000

describe("RecentChecks", () => {
  test("a key is checked once per interval, then again", () => {
    const checks = new RecentChecks(10 * MINUTE, 100)
    expect(checks.begin("mu_a", 0)).toBe(true)
    expect(checks.begin("mu_a", 1)).toBe(false)
    expect(checks.begin("mu_a", 10 * MINUTE - 1)).toBe(false)
    expect(checks.begin("mu_a", 10 * MINUTE)).toBe(true)
    // Other keys are independent.
    expect(checks.begin("mu_b", 1)).toBe(true)
  })

  test("a forgotten key is checked again at once", () => {
    const checks = new RecentChecks(10 * MINUTE, 100)
    expect(checks.begin("mu_a", 0)).toBe(true)
    checks.forget("mu_a")
    expect(checks.begin("mu_a", 1)).toBe(true)
  })

  test("keeps at most maxEntries keys, dropping the least recently checked", () => {
    const checks = new RecentChecks(10 * MINUTE, 3)
    for (const [index, key] of ["mu_1", "mu_2", "mu_3"].entries()) checks.begin(key, index)
    // mu_1 is checked again later, so mu_2 is now the oldest.
    expect(checks.begin("mu_1", 10 * MINUTE + 5)).toBe(true)
    expect(checks.begin("mu_4", 10 * MINUTE + 6)).toBe(true)
    expect(checks.size).toBe(3)
    expect(checks.begin("mu_2", 10 * MINUTE + 7)).toBe(true)
    expect(checks.begin("mu_1", 10 * MINUTE + 8)).toBe(false)

    const many = new RecentChecks(10 * MINUTE, 10_000)
    for (let i = 0; i < 25_000; i++) many.begin(`mu_${i}`, i)
    expect(many.size).toBe(10_000)
    expect(many.begin("mu_24999", 25_000)).toBe(false)
    expect(many.begin("mu_0", 25_000)).toBe(true)
  })
})
