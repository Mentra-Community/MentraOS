import {describe, expect, test} from "bun:test"
import {currentDeclaredAge, DeclaredAgeRequestSchema, DeclaredAgeSchema} from "./declared-age"

describe("the declared-age request", () => {
  test.each([1, 12, 120])("accepts the whole number %p", (age) => {
    expect(DeclaredAgeRequestSchema.safeParse({age}).success).toBe(true)
  })

  test.each([
    ["zero", 0],
    ["a negative age", -3],
    ["an age past 120", 121],
    ["a fraction", 12.5],
    ["text", "12"],
    ["nothing", undefined],
  ])("refuses %s", (_label, age) => {
    expect(DeclaredAgeRequestSchema.safeParse({age}).success).toBe(false)
  })
})

describe("Core's declared-age answer", () => {
  test("is both fields, or neither", () => {
    expect(DeclaredAgeSchema.safeParse({declaredAge: 15, declaredAgeAt: "2026-10-24T08:00:00.000Z"}).success).toBe(true)
    expect(DeclaredAgeSchema.safeParse({declaredAge: null, declaredAgeAt: null}).success).toBe(true)
    expect(DeclaredAgeSchema.safeParse({declaredAge: 15, declaredAgeAt: null}).success).toBe(false)
    expect(DeclaredAgeSchema.safeParse({declaredAge: null, declaredAgeAt: "2026-10-24T08:00:00.000Z"}).success).toBe(
      false,
    )
    expect(DeclaredAgeSchema.safeParse({declaredAge: 15, declaredAgeAt: "yesterday"}).success).toBe(false)
  })
})

describe("the person's age now", () => {
  const at = "2026-10-24T08:00:00.000Z"

  test("is the age they gave until the first anniversary", () => {
    expect(currentDeclaredAge(12, at, new Date("2026-10-24T08:00:00.000Z"))).toBe(12)
    expect(currentDeclaredAge(12, at, new Date("2027-10-23T23:59:59.000Z"))).toBe(12)
  })

  test("grows by one on each anniversary of the answer", () => {
    expect(currentDeclaredAge(12, at, new Date("2027-10-24T00:00:00.000Z"))).toBe(13)
    expect(currentDeclaredAge(12, at, new Date("2031-11-01T00:00:00.000Z"))).toBe(17)
  })

  test("counts an answer given on 29 February from 1 March in other years", () => {
    const leap = "2028-02-29T12:00:00.000Z"
    expect(currentDeclaredAge(15, leap, new Date("2029-02-28T12:00:00.000Z"))).toBe(15)
    expect(currentDeclaredAge(15, leap, new Date("2029-03-01T00:00:00.000Z"))).toBe(16)
  })

  test("never falls below the age they gave when the clock is behind", () => {
    expect(currentDeclaredAge(12, at, new Date("2025-01-01T00:00:00.000Z"))).toBe(12)
  })
})
