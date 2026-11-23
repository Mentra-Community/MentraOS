/// <reference types="bun-types" />

import {afterEach, describe, expect, test} from "bun:test"

import {
  fetchListedMiniappUrl,
  isMiniappLink,
  isOnMiniappLinkHost,
  MINIAPP_LINK_HOSTS,
  miniappPackageLink,
  parseMiniappLink,
} from "../index"

const NOTES = {kind: "url", url: "https://notes.example.com/", local: false} as const

describe("parseMiniappLink", () => {
  test.each([
    ["https://notes.example.com/", "https://notes.example.com/"],
    ["https://notes.example.com", "https://notes.example.com/"],
    ["  https://Notes.Example.com/app  ", "https://notes.example.com/app/"],
    ["https://alice.github.io/notes/miniapp.json", "https://alice.github.io/notes/"],
    ["notes.example.com/app", "https://notes.example.com/app/"],
  ])("reads a miniapp URL %j", (input, url) => {
    expect(parseMiniappLink(input)).toEqual({kind: "url", url, local: false})
  })

  test("reads a local-network address", () => {
    expect(parseMiniappLink("http://192.168.1.20:8080/")).toEqual({
      kind: "url",
      url: "http://192.168.1.20:8080/",
      local: true,
    })
  })

  test.each([
    "https://apps.mentraglass.com/open?url=https%3A%2F%2Fnotes.example.com%2F",
    "https://apps.mentraglass.com/open?url=https://notes.example.com/",
    "https://apps.mentra.glass/open?url=https%3A%2F%2Fnotes.example.com%2F",
    "https://APPS.mentraglass.com/open/?url=https%3A%2F%2Fnotes.example.com%2Fminiapp.json",
    "apps.mentraglass.com/open?url=notes.example.com",
    // Typed without a scheme, naming a URL that has one.
    "apps.mentraglass.com/open?url=https://notes.example.com/",
  ])("reads the miniapp URL an open link names: %s", (input) => {
    expect(parseMiniappLink(input)).toEqual(NOTES)
  })

  test.each([
    "https://apps.mentraglass.com/package/com.example.notes",
    "https://apps.mentraglass.com/package/com.example.notes/",
    "https://apps.mentra.glass/package/com.example.notes",
    "https://apps.mentraglass.com/app/com.example.notes",
  ])("reads the package a package link names: %s", (input) => {
    expect(parseMiniappLink(input)).toEqual({kind: "package", packageName: "com.example.notes"})
  })

  test.each([
    "",
    "   ",
    "not a url at all",
    "http://notes.example.com/",
    "https://notes.example.com/?x=1",
    "https://apps.mentraglass.com/",
    "https://apps.mentraglass.com/open",
    "https://apps.mentraglass.com/open?url=",
    "https://apps.mentraglass.com/package/Not-A-Package",
    // An open link names a miniapp, never another open link.
    "https://apps.mentraglass.com/open?url=https%3A%2F%2Fapps.mentraglass.com%2Fopen%3Furl%3Dhttps%253A%252F%252Fnotes.example.com",
    "javascript:alert(1)",
    "ftp://notes.example.com/",
    "notes.example.com/?next=https://other.example.com/",
  ])("refuses %j", (input) => {
    expect(parseMiniappLink(input)).toBeNull()
  })

  test("reads the host app's own schemes only when it names them", () => {
    const open = "myapp://open?url=https%3A%2F%2Fnotes.example.com%2F"
    const pkg = "MyApp://package/com.example.notes"
    expect(parseMiniappLink(open)).toBeNull()
    expect(parseMiniappLink(pkg)).toBeNull()
    expect(parseMiniappLink(open, {schemes: ["myapp"]})).toEqual(NOTES)
    expect(parseMiniappLink(pkg, {schemes: ["myapp"]})).toEqual({kind: "package", packageName: "com.example.notes"})
    expect(parseMiniappLink("myapp://home", {schemes: ["myapp"]})).toBeNull()
    expect(parseMiniappLink("other://open?url=https%3A%2F%2Fnotes.example.com%2F", {schemes: ["myapp"]})).toBeNull()
  })

  test("an open link on the app's scheme never names another link on it", () => {
    const nested = `myapp://open?url=${encodeURIComponent("myapp://open?url=https://notes.example.com/")}`
    expect(parseMiniappLink(nested, {schemes: ["myapp"]})).toBeNull()
  })
})

describe("isMiniappLink", () => {
  test.each([
    "https://apps.mentraglass.com/open?url=https%3A%2F%2Fnotes.example.com%2F",
    "https://apps.mentraglass.com/open?url=garbage",
    "https://apps.mentra.glass/package/com.example.notes",
    "https://apps.mentraglass.com/package/Not-A-Package",
    "/open?url=https%3A%2F%2Fnotes.example.com%2F",
    "/package/com.example.notes",
  ])("is a miniapp link: %s", (link) => {
    expect(isMiniappLink(link)).toBe(true)
  })

  test.each([
    "https://apps.mentraglass.com/",
    "https://apps.mentraglass.com/apps/com.example.notes",
    "https://notes.example.com/open?url=x",
    "https://notes.example.com/",
    "myapp://open?url=x",
    "/home",
  ])("is not: %s", (link) => {
    expect(isMiniappLink(link)).toBe(false)
  })

  test("reads the host app's own schemes when it names them", () => {
    expect(isMiniappLink("myapp://open?url=x", {schemes: ["myapp"]})).toBe(true)
    expect(isMiniappLink("myapp://package/com.example.notes", {schemes: ["myapp"]})).toBe(true)
    expect(isMiniappLink("myapp://auth/callback?code=x", {schemes: ["myapp"]})).toBe(false)
  })
})

describe("isOnMiniappLinkHost", () => {
  test.each([
    "https://apps.mentraglass.com/open?url=https%3A%2F%2Fnotes.example.com%2F",
    "https://apps.mentraglass.com/",
    "HTTPS://Apps.Mentra.Glass/apps/com.example.notes",
    "https://apps.mentraglass.com./package/com.example.notes",
    "http://apps.mentraglass.com/",
  ])("any address on a link host is the host app's: %s", (url) => {
    expect(isOnMiniappLinkHost(url)).toBe(true)
  })

  test.each([
    "https://notes.example.com/",
    "https://mentraglass.com/",
    "https://apps.mentraglass.com.example.com/open",
    "https://evil.example/?u=https://apps.mentraglass.com/open",
    "myapp://open?url=x",
    "mailto:someone@example.com",
    "not a url",
  ])("is not: %s", (url) => {
    expect(isOnMiniappLinkHost(url)).toBe(false)
  })

  test("anything on the host app's own schemes is the host app's", () => {
    expect(isOnMiniappLinkHost("myapp://open?url=x", {schemes: ["myapp"]})).toBe(true)
    expect(isOnMiniappLinkHost("MYAPP://auth/callback?code=x", {schemes: ["myapp"]})).toBe(true)
    expect(isOnMiniappLinkHost("other://open?url=x", {schemes: ["myapp"]})).toBe(false)
  })
})

describe("miniappPackageLink", () => {
  test("is the package's page on the directory website, a link host", () => {
    const link = miniappPackageLink("com.example.notes")
    expect(link).toBe("https://apps.mentraglass.com/package/com.example.notes")
    expect(MINIAPP_LINK_HOSTS).toContain(new URL(link).hostname)
    expect(parseMiniappLink(link)).toEqual({kind: "package", packageName: "com.example.notes"})
  })
})

describe("fetchListedMiniappUrl", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function answer(status: number, body?: unknown): string[] {
    const requested: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requested.push(String(input))
      expect(init?.credentials).toBe("omit")
      return new Response(body === undefined ? null : JSON.stringify(body), {status})
    }) as typeof fetch
    return requested
  }

  test("asks the directory for the package, without credentials", async () => {
    const requested = answer(200, {packageName: "com.example.notes", url: "https://notes.example.com"})
    await expect(fetchListedMiniappUrl("https://apps.mentraglass.com/", "com.example.notes")).resolves.toBe(
      "https://notes.example.com/",
    )
    expect(requested).toEqual(["https://apps.mentraglass.com/api/directory/miniapps/com.example.notes"])
  })

  test("a package the directory doesn't list is null", async () => {
    answer(404)
    await expect(fetchListedMiniappUrl("https://apps.mentraglass.com", "com.example.notes")).resolves.toBeNull()
  })

  test.each([
    [{packageName: "com.example.other", url: "https://notes.example.com/"}],
    [{packageName: "com.example.notes"}],
    [{packageName: "com.example.notes", url: "http://192.168.1.20:8080/"}],
    [null],
  ])("an answer that names no public URL for the package is null: %j", async (body) => {
    answer(200, body)
    await expect(fetchListedMiniappUrl("https://apps.mentraglass.com", "com.example.notes")).resolves.toBeNull()
  })

  test("a directory that can't answer throws", async () => {
    answer(503)
    await expect(fetchListedMiniappUrl("https://apps.mentraglass.com", "com.example.notes")).rejects.toThrow("503")
  })
})
