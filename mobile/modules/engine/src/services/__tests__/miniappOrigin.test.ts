/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {developmentOriginName, miniappOrigin, miniappOriginHost, miniappOriginUrl} from "../miniappOrigin"

describe("miniapp origins", () => {
  test("each package gets its own origin on each platform", () => {
    expect(miniappOrigin("com.mentra.notes", "ios")).toBe("miniapp://com.mentra.notes")
    expect(miniappOrigin("com.mentra.notes", "android")).toBe("https://com.mentra.notes.miniapp.invalid")
    expect(miniappOrigin("com.mentra.call", "ios")).not.toBe(miniappOrigin("com.mentra.notes", "ios"))
  })

  test("Android writes _ as -, so a package's host is a DNS name", () => {
    expect(miniappOriginHost("com.my_site.app")).toBe("com.my-site.app.miniapp.invalid")
    expect(miniappOrigin("com.my_site.app", "ios")).toBe("miniapp://com.my_site.app")
  })

  test("names outside the package-name pattern have no origin", () => {
    for (const name of [
      "",
      "com",
      "Com.mentra.notes",
      "com.my-site.app",
      "com..notes",
      "1com.notes",
      "com._notes",
      "com.notes.",
    ]) {
      expect(miniappOrigin(name, "ios")).toBeNull()
      expect(miniappOrigin(name, "android")).toBeNull()
    }
  })

  test("a host past DNS limits has no Android origin", () => {
    expect(miniappOriginHost(`com.${"b".repeat(63)}`)).not.toBeNull()
    expect(miniappOriginHost(`com.${"b".repeat(64)}`)).toBeNull()
    const long = `com${".abcdefghij".repeat(23)}`
    expect(miniappOriginHost(long)).toBeNull()
  })

  test("a bundle file's URL", () => {
    expect(miniappOriginUrl("com.mentra.notes", "dist/ui/index.html", "ios")).toBe(
      "miniapp://com.mentra.notes/dist/ui/index.html",
    )
    expect(miniappOriginUrl("com.mentra.notes", "./ui/index.html", "android")).toBe(
      "https://com.mentra.notes.miniapp.invalid/ui/index.html",
    )
    expect(miniappOriginUrl("com.mentra.notes", "/ui/my page.html", "ios")).toBe(
      "miniapp://com.mentra.notes/ui/my%20page.html",
    )
  })

  test("a path that leaves the bundle has no URL", () => {
    for (const path of ["", "/", "../secret.html", "ui/../../x.html", "ui/./index.html", "ui\\index.html"]) {
      expect(miniappOriginUrl("com.mentra.notes", path, "ios")).toBeNull()
    }
    expect(miniappOriginUrl("Bad.Name", "index.html", "ios")).toBeNull()
  })
})

describe("a development build's origin", () => {
  test("is its own on each platform, apart from the package's", () => {
    const name = developmentOriginName("com.mentra.notes")
    expect(miniappOrigin(name, "ios")).toBe("miniapp://invalid.dev.com.mentra.notes")
    expect(miniappOrigin(name, "android")).toBe("https://invalid.dev.com.mentra.notes.miniapp.invalid")
    for (const platform of ["ios", "android"] as const) {
      expect(miniappOrigin(name, platform)).not.toBe(miniappOrigin("com.mentra.notes", platform))
    }
    expect(miniappOriginUrl(name, "ui/index.html", "ios")).toBe("miniapp://invalid.dev.com.mentra.notes/ui/index.html")
  })

  test("of one package is never another package's, nor another development build's", () => {
    expect(developmentOriginName("com.acme.notes")).not.toBe(developmentOriginName("com.acme.other"))
    // A development build may claim even a name under invalid.dev., whose origin is then one more level down.
    expect(developmentOriginName(developmentOriginName("com.acme.notes"))).not.toBe(
      developmentOriginName("com.acme.notes"),
    )
  })
})
