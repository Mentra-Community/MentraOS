import {afterEach, describe, expect, test} from "bun:test"
import {enabledFeaturesConfigured, parseEnabledFeatures} from "./enabled-features"

/** An environment for one call: nothing is read from the process unless a test says so. */
const env = (value?: string): NodeJS.ProcessEnv => (value === undefined ? {} : {CLOUD_CORE_ENABLED_FEATURES: value})

/** The parsed setting as plain arrays, for readable comparisons. */
function listed(value?: string): Record<string, string[]> {
  return Object.fromEntries(
    [...parseEnabledFeatures(env(value))].map(([feature, packages]) => [feature, [...packages]]),
  )
}

describe("parseEnabledFeatures", () => {
  test("an unset, blank or separator-only setting lists no feature", () => {
    for (const value of [undefined, "", "   ", " , ,", ",", ":", ":com.mentra.call"]) {
      expect(listed(value)).toEqual({})
    }
  })

  test("an entry with no packages is a feature for no package", () => {
    expect(listed("fleet.managed")).toEqual({"fleet.managed": []})
    expect(listed("fleet.managed:")).toEqual({"fleet.managed": []})
  })

  test("an entry with packages lists them, joined by +", () => {
    expect(listed("call.unlimited:com.mentra.call")).toEqual({"call.unlimited": ["com.mentra.call"]})
    expect(listed("call.unlimited:com.mentra.call+com.example.dialer")).toEqual({
      "call.unlimited": ["com.mentra.call", "com.example.dialer"],
    })
  })

  test("entries are comma-separated, and whitespace around names and packages is ignored", () => {
    expect(listed("  call.unlimited : com.mentra.call + com.example.dialer ,\n fleet.managed , ")).toEqual({
      "call.unlimited": ["com.mentra.call", "com.example.dialer"],
      "fleet.managed": [],
    })
  })

  test("a feature listed twice gets the union of its packages", () => {
    expect(
      listed("call.unlimited,call.unlimited:com.mentra.call,call.unlimited:com.mentra.call+com.example.dialer"),
    ).toEqual({"call.unlimited": ["com.mentra.call", "com.example.dialer"]})
  })

  test("empty package names are dropped", () => {
    expect(listed("call.unlimited:+com.mentra.call++")).toEqual({"call.unlimited": ["com.mentra.call"]})
    expect(listed("call.unlimited:+")).toEqual({"call.unlimited": []})
  })

  test("names are case-sensitive", () => {
    expect(listed("Fleet.Managed:Com.Mentra.Call")).toEqual({"Fleet.Managed": ["Com.Mentra.Call"]})
  })

  test("everything after the first colon is the package list", () => {
    expect(listed("call.unlimited:com.mentra.call:extra")).toEqual({"call.unlimited": ["com.mentra.call:extra"]})
  })
})

describe("enabledFeaturesConfigured", () => {
  test("is false for an unset or blank setting, the hosted Core", () => {
    for (const value of [undefined, "", "   ", "\n"]) expect(enabledFeaturesConfigured(env(value))).toBe(false)
  })

  test("is true for any other value, even one that lists no feature", () => {
    for (const value of ["fleet.managed", " , ,", ":"]) expect(enabledFeaturesConfigured(env(value))).toBe(true)
  })
})

describe("the process environment", () => {
  const saved = process.env.CLOUD_CORE_ENABLED_FEATURES
  afterEach(() => {
    if (saved === undefined) delete process.env.CLOUD_CORE_ENABLED_FEATURES
    else process.env.CLOUD_CORE_ENABLED_FEATURES = saved
  })

  test("is read when no environment is passed", () => {
    process.env.CLOUD_CORE_ENABLED_FEATURES = "call.unlimited:com.mentra.call"
    expect([...parseEnabledFeatures()]).toEqual([["call.unlimited", new Set(["com.mentra.call"])]])
    expect(enabledFeaturesConfigured()).toBe(true)

    delete process.env.CLOUD_CORE_ENABLED_FEATURES
    expect(parseEnabledFeatures().size).toBe(0)
    expect(enabledFeaturesConfigured()).toBe(false)
  })
})
