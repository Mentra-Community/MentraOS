import {
  directoryPackageLink,
  isMentraAppLink,
  isMiniappInstallLinkPath,
  parseMiniappInstallLink,
} from "./miniappInstallLinks"

describe("parseMiniappInstallLink", () => {
  it.each([
    ["https://notes.example.com/", "https://notes.example.com/"],
    ["https://notes.example.com", "https://notes.example.com/"],
    ["  https://Notes.Example.com/app  ", "https://notes.example.com/app/"],
    ["https://alice.github.io/notes/", "https://alice.github.io/notes/"],
  ])("reads a miniapp URL %j", (input, url) => {
    expect(parseMiniappInstallLink(input)).toEqual({kind: "url", url, local: false})
  })

  it.each([
    ["https://notes.example.com/miniapp.json", "https://notes.example.com/"],
    ["https://alice.github.io/notes/miniapp.json", "https://alice.github.io/notes/"],
    ["https://alice.github.io/notes/miniapp.json/", "https://alice.github.io/notes/"],
  ])("drops a trailing miniapp.json from %j", (input, url) => {
    expect(parseMiniappInstallLink(input)).toEqual({kind: "url", url, local: false})
  })

  it("reads a pasted address without a scheme as HTTPS", () => {
    expect(parseMiniappInstallLink("notes.example.com/app")).toEqual({
      kind: "url",
      url: "https://notes.example.com/app/",
      local: false,
    })
  })

  it("reads a local-network address", () => {
    expect(parseMiniappInstallLink("http://192.168.1.20:8080/")).toEqual({
      kind: "url",
      url: "http://192.168.1.20:8080/",
      local: true,
    })
  })

  it.each([
    "https://apps.mentraglass.com/open?url=https%3A%2F%2Fnotes.example.com%2F",
    "https://apps.mentra.glass/open?url=https%3A%2F%2Fnotes.example.com%2F",
    "https://APPS.mentraglass.com/open/?url=https%3A%2F%2Fnotes.example.com%2Fminiapp.json",
    "com.mentra://open?url=https%3A%2F%2Fnotes.example.com%2F",
    "apps.mentraglass.com/open?url=notes.example.com",
  ])("reads the miniapp URL an open link names: %s", (input) => {
    expect(parseMiniappInstallLink(input)).toEqual({kind: "url", url: "https://notes.example.com/", local: false})
  })

  it.each([
    "https://apps.mentraglass.com/open",
    "https://apps.mentraglass.com/open?url=",
    "https://apps.mentraglass.com/open?url=http%3A%2F%2Fnotes.example.com%2F",
    // An open link names a miniapp, never another open link.
    "https://apps.mentraglass.com/open?url=https%3A%2F%2Fapps.mentraglass.com%2Fopen%3Furl%3Dhttps%253A%252F%252Fnotes.example.com",
  ])("refuses an open link without a miniapp URL: %s", (input) => {
    expect(parseMiniappInstallLink(input)).toBeNull()
  })

  it.each([
    "https://apps.mentraglass.com/package/com.example.notes",
    "https://apps.mentraglass.com/package/com.example.notes/",
    "https://apps.mentra.glass/package/com.example.notes",
    "https://apps.mentraglass.com/app/com.example.notes",
    "com.mentra://package/com.example.notes",
    "apps.mentraglass.com/package/com.example.notes",
  ])("reads the package a package link names: %s", (input) => {
    expect(parseMiniappInstallLink(input)).toEqual({kind: "package", packageName: "com.example.notes"})
  })

  it.each([
    "",
    "   ",
    "not a url at all",
    "http://notes.example.com/",
    "ftp://notes.example.com/",
    "https://notes.example.com/?x=1",
    "https://apps.mentraglass.com/",
    "https://apps.mentraglass.com/search?q=notes",
    "https://apps.mentraglass.com/package/Not-A-Package",
    "com.mentra://home",
    "miniapp://dev?url=http%3A%2F%2F192.168.1.20%3A8080",
    "javascript:alert(1)",
  ])("refuses %j", (input) => {
    expect(parseMiniappInstallLink(input)).toBeNull()
  })
})

describe("isMiniappInstallLinkPath", () => {
  it.each([
    "https://apps.mentraglass.com/open?url=https%3A%2F%2Fnotes.example.com%2F",
    "https://apps.mentraglass.com/open?url=garbage",
    "https://apps.mentra.glass/package/com.example.notes",
    "https://apps.mentraglass.com/package/Not-A-Package",
    "com.mentra://open?url=x",
    "com.mentra://package/com.example.notes",
    "/open?url=https%3A%2F%2Fnotes.example.com%2F",
    "/package/com.example.notes",
  ])("is an install link: %s", (path) => {
    expect(isMiniappInstallLinkPath(path)).toBe(true)
  })

  it.each([
    "https://apps.mentraglass.com/",
    "https://apps.mentraglass.com/apps/com.example.notes",
    "https://notes.example.com/open?url=x",
    "com.mentra://auth/callback?code=x",
    "/home",
  ])("is not: %s", (path) => {
    expect(isMiniappInstallLinkPath(path)).toBe(false)
  })
})

describe("directoryPackageLink", () => {
  it("is the package's page on the directory website", () => {
    expect(directoryPackageLink("com.example.notes")).toBe("https://apps.mentraglass.com/package/com.example.notes")
  })
})

describe("isMentraAppLink", () => {
  it.each([
    "com.mentra://open?url=https%3A%2F%2Fnotes.example.com%2F",
    "COM.MENTRA://auth/callback?code=x&state=y",
    "com.mentra://test/load-miniapp?package=com.example.notes",
    "msauth.com.mentra.mentra://auth",
    "msauth://com.mentra.mentra/hash?code=x",
    "com.mentra.mentra://open?url=x",
    "com.mentra.mentra.stable://home",
    "https://apps.mentraglass.com/open?url=https%3A%2F%2Fnotes.example.com%2F",
    "https://apps.mentraglass.com/package/com.example.notes",
    "https://apps.mentraglass.com./auth/reset-password#access_token=x",
    "HTTPS://Apps.Mentra.Glass/apps/com.example.notes",
    "http://apps.mentraglass.com/",
  ])("is the Mentra App's own link: %s", (url) => {
    expect(isMentraAppLink(url)).toBe(true)
  })

  it.each([
    "https://notes.example.com/",
    "https://mentraglass.com/",
    "https://docs.mentraglass.com/",
    "https://apps.mentraglass.com.example.com/open",
    "https://evil.example/?u=https://apps.mentraglass.com/open",
    "mailto:someone@example.com",
    "tel:+15555550100",
    "not a url",
  ])("is not: %s", (url) => {
    expect(isMentraAppLink(url)).toBe(false)
  })
})
