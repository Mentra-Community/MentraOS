const {resolveAnalyticsProps, normalizeAnalyticsEnvironment} = require("../analyticsProps")

describe("Bluetooth SDK analytics plugin props", () => {
  it("leaves the native default alone when nothing is configured", () => {
    expect(resolveAnalyticsProps(undefined)).toEqual({disabled: undefined, environment: undefined})
    expect(resolveAnalyticsProps({})).toEqual({disabled: undefined, environment: undefined})
  })

  it("maps the boolean shorthand", () => {
    expect(resolveAnalyticsProps({analytics: false}).disabled).toBe(true)
    expect(resolveAnalyticsProps({analytics: true}).disabled).toBe(false)
  })

  it("accepts an environment alongside the enabled flag", () => {
    expect(resolveAnalyticsProps({analytics: {enabled: true, environment: " Prod "}})).toEqual({
      disabled: false,
      environment: "prod",
    })
    expect(resolveAnalyticsProps({analytics: {environment: "staging"}})).toEqual({
      disabled: undefined,
      environment: "staging",
    })
  })

  it("rejects environments that would not survive as a PostHog filter value", () => {
    expect(() => normalizeAnalyticsEnvironment("has space")).toThrow(/analytics\.environment/)
    expect(() => normalizeAnalyticsEnvironment("-leading")).toThrow(/analytics\.environment/)
    expect(() => normalizeAnalyticsEnvironment("a".repeat(33))).toThrow(/analytics\.environment/)
    expect(() => normalizeAnalyticsEnvironment(42)).toThrow(/must be a string/)
    expect(normalizeAnalyticsEnvironment("")).toBeUndefined()
  })
})
