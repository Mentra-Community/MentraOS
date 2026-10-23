import {describe, expect, test} from "bun:test"
import {isSafeSuffix, joinUpstreamUrl, parseUpstreamUrl, rawPathAndQuery} from "./upstream-url"

describe("parseUpstreamUrl", () => {
  test("accepts https anywhere and keeps the path prefix", () => {
    for (const deployed of [false, true]) {
      expect(parseUpstreamUrl("https://mfm.example.test", deployed)?.href).toBe("https://mfm.example.test/")
      expect(parseUpstreamUrl("https://mfm.example.test/fleet/", deployed)?.href).toBe("https://mfm.example.test/fleet/")
    }
  })

  test("plain http is for a local or test Core, and for localhost only on a deployed one", () => {
    expect(parseUpstreamUrl("http://upstream.internal:8080", false)?.hostname).toBe("upstream.internal")
    expect(parseUpstreamUrl("http://upstream.internal:8080", true)).toBeNull()
    for (const host of ["localhost", "127.0.0.1"]) {
      expect(parseUpstreamUrl(`http://${host}:8080/billing`, true)?.hostname).toBe(host)
    }
  })

  test("refuses credentials, a query, a fragment, another scheme and what is not a URL", () => {
    for (const raw of [
      "https://user:pass@mfm.example.test",
      "https://user@mfm.example.test",
      "https://mfm.example.test/?a=1",
      "https://mfm.example.test/#top",
      "ftp://mfm.example.test",
      "mfm.example.test",
      "",
    ]) {
      expect([raw, parseUpstreamUrl(raw, false)]).toEqual([raw, null])
    }
  })
})

describe("joinUpstreamUrl", () => {
  const join = (base: string, path: string, query = "") => joinUpstreamUrl(new URL(base), path, query).href

  test("joins the base URL's path prefix, with or without trailing slashes, to the path and query", () => {
    for (const base of ["https://m.example.test", "https://m.example.test/", "https://m.example.test//"]) {
      expect(join(base, "/v1/portal/workspaces/ws_1/x", "?a=1")).toBe("https://m.example.test/v1/portal/workspaces/ws_1/x?a=1")
    }
    for (const base of ["https://m.example.test/billing", "https://m.example.test/billing/", "https://m.example.test/billing//"]) {
      expect(join(base, "/v1/portal/ui/entry.js")).toBe("https://m.example.test/billing/v1/portal/ui/entry.js")
    }
    expect(join("http://127.0.0.1:3004", "/v1/admin")).toBe("http://127.0.0.1:3004/v1/admin")
  })

  test("sends the path as received: no segment is resolved or re-encoded", () => {
    expect(join("https://m.example.test", "/v1/portal/workspaces/ws%5F1/a%20b")).toBe(
      "https://m.example.test/v1/portal/workspaces/ws%5F1/a%20b",
    )
  })
})

describe("rawPathAndQuery", () => {
  test("splits a URL after its origin and keeps dot segments, which `new URL` would collapse", () => {
    expect(rawPathAndQuery("http://localhost/api/portal/billing/workspaces/ws_1/x?y=1")).toEqual({
      path: "/api/portal/billing/workspaces/ws_1/x",
      query: "?y=1",
    })
    expect(rawPathAndQuery("http://localhost/a/../b").path).toBe("/a/../b")
    expect(rawPathAndQuery("http://localhost")).toEqual({path: "/", query: ""})
  })

  test("drops a fragment and a lone question mark", () => {
    expect(rawPathAndQuery("http://localhost/a?b=1#frag")).toEqual({path: "/a", query: "?b=1"})
    expect(rawPathAndQuery("http://localhost/a?")).toEqual({path: "/a", query: ""})
  })
})

describe("isSafeSuffix", () => {
  test("accepts ordinary paths, encoded spaces included", () => {
    for (const suffix of ["", "/", "/workspaces/ws_1/licenses", "/workspaces/ws_1/a%20b", "/ui/entry.js", "/a//b"]) {
      expect([suffix, isSafeSuffix(suffix)]).toEqual([suffix, true])
    }
  })

  test("refuses dot segments, separators, control characters and bad escapes however they are spelled", () => {
    for (const suffix of [
      "/a/./b",
      "/a/../b",
      "/a/%2e/b",
      "/a/%2E%2E/b",
      "/a%2fb",
      "/a%5cb",
      "/a\\b",
      "/a%00b",
      "/a%0ab",
      "/a%7fb",
      "/a%zzb",
      "/a/%252e/b",
      "/a%252fb",
      "/a%255cb",
    ]) {
      expect([suffix, isSafeSuffix(suffix)]).toEqual([suffix, false])
    }
  })
})
