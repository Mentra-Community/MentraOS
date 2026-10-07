import {getWebViewLoadErrorDiagnostics} from "../webViewLoadErrorDiagnostics"

const fakeJwt = [
  Buffer.from(JSON.stringify({alg: "none"})).toString("base64url"),
  Buffer.from(JSON.stringify({sub: "test-only"})).toString("base64url"),
  "fakeSignature",
].join(".")

jest.mock("@mentra/engine-host-internal", () => ({
  redactSecrets: jest.requireActual("../../../../modules/engine/src/services/MentraJSLogPipeline").redactSecrets,
}))

it("retains the original native cause and excludes unselected event fields", () => {
  const event = {
    domain: "NSURLErrorDomain",
    code: -1009,
    description: "The Internet connection appears to be offline.",
    url: "https://example.com/?access_token=private",
    title: "private page title",
  }
  expect(getWebViewLoadErrorDiagnostics(event)).toEqual({
    domain: "NSURLErrorDomain",
    code: -1009,
    description: "The Internet connection appears to be offline.",
  })
})

it.each([
  "Could not load https://example.com/private?access_token=private#fragment",
  "Could not load file:///private/miniapps/com.mentra.notes/ui/index.html",
  "Could not load ?access_token=private",
  "Could not load about:blank",
  "Could not load data:text/html,private",
  `Access failed: ${fakeJwt}`,
  "Access failed: access_token=private",
])("removes URLs, queries and credentials from %s", (description) => {
  const result = getWebViewLoadErrorDiagnostics({code: -1, description})
  expect(result.description).not.toMatch(/example\.com|\/private\/|access_token|private|eyJhbG|about:|data:/)
  expect(result.description).toContain("[REDACTED]")
  expect(result.code).toBe(-1)
})

it("bounds text and tolerates absent platform-specific fields", () => {
  const result = getWebViewLoadErrorDiagnostics({code: Number.NaN, description: "x".repeat(2_000)})
  expect(result).toEqual({domain: undefined, code: undefined, description: "x".repeat(512)})
})
