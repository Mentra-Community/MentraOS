import {describe, expect, test} from "bun:test"

import {websiteOfTokenAnswer} from "./oidc.api"

const WEBSITE = "mwc_01hzy3v8n0f2e9gq4t6kxh5rd0"

describe("whose token answer the relay is looking at", () => {
  test("a website's, when the provider issued the token to one", () => {
    expect(websiteOfTokenAnswer(WEBSITE, WEBSITE)).toBe(WEBSITE)
    // However the request named its client.
    expect(websiteOfTokenAnswer(WEBSITE, "")).toBe(WEBSITE)
    expect(websiteOfTokenAnswer(WEBSITE, "mentra-cli")).toBe(WEBSITE)
  })

  test("a website's, when the request named one and the token does not say whose it is", () => {
    // The answer is then checked against that website and refused: it is never passed through as it came.
    expect(websiteOfTokenAnswer("", WEBSITE)).toBe(WEBSITE)
    expect(websiteOfTokenAnswer("mentra-cli", WEBSITE)).toBe(WEBSITE)
  })

  test("nobody's, for a first-party client: its answer passes through unchanged", () => {
    expect(websiteOfTokenAnswer("mentra-cli", "mentra-cli")).toBe("")
    expect(websiteOfTokenAnswer("console", "")).toBe("")
    expect(websiteOfTokenAnswer("", "")).toBe("")
  })
})
