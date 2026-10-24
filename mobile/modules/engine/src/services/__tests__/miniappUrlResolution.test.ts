/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

import "./cloudClientServiceTestMock"

let config: {hostVersion?: string; supportedMiniappSdkRange?: string} = {}
mock.module("../../runtime/bootstrap", () => ({getConfigValues: () => config}))
// Each test passes its own transport.
mock.module("expo/fetch", () => ({
  fetch: async () => {
    throw new Error("no transport")
  },
}))

const {resolveMiniappUrl} = await import("../miniappUrlResolution")
const {normalizeMiniappUrl} = await import("@mentra/cloud-protocol/miniapp-url")
const {domainRuleVectors} = await import("./miniappUrlVectors")

const pkg = "com.acme.notes"
const SHA = "a".repeat(64)

function manifest(extra: Record<string, unknown> = {}) {
  return {packageName: pkg, version: "2.0.0", name: "Notes", bundle: {url: "notes-2.0.0.zip", sha256: SHA}, ...extra}
}

/** Serves `body` with `status`; `finalUrl` is where redirects ended. */
function serve(status: number, body?: unknown, finalUrl?: string, seen: string[] = []): typeof fetch {
  return (async (url: string) => {
    seen.push(url)
    const response = new Response(body === undefined ? null : JSON.stringify(body), {status})
    Object.defineProperty(response, "url", {value: finalUrl ?? url})
    return response
  }) as unknown as typeof fetch
}

beforeEach(() => {
  config = {}
})

describe("resolving a miniapp URL", () => {
  test("reads <url>/miniapp.json; the URL decides the version and its bundle names the ZIP and its SHA-256", async () => {
    const seen: string[] = []
    expect(await resolveMiniappUrl("https://notes.acme.com/app", serve(200, manifest(), undefined, seen))).toEqual({
      ok: true,
      packageName: pkg,
      version: "2.0.0",
      bundleUrl: "https://notes.acme.com/app/notes-2.0.0.zip",
      bundleSha256: SHA,
    })
    expect(seen).toEqual(["https://notes.acme.com/app/miniapp.json"])
  })

  test("a relative bundle URL resolves against where redirects ended; an absolute HTTPS one is kept", async () => {
    const moved = serve(200, manifest(), "https://cdn.acme.com/notes/miniapp.json")
    expect(await resolveMiniappUrl("https://notes.acme.com/app/", moved)).toMatchObject({
      ok: true,
      bundleUrl: "https://cdn.acme.com/notes/notes-2.0.0.zip",
    })
    const absolute = serve(200, manifest({bundle: {url: "https://files.example.net/n.zip", sha256: SHA.toUpperCase()}}))
    expect(await resolveMiniappUrl("https://notes.acme.com/app/", absolute)).toMatchObject({
      ok: true,
      bundleUrl: "https://files.example.net/n.zip",
      bundleSha256: SHA,
    })
  })

  test.each([
    ["no bundle", {bundle: undefined}],
    ["no SHA-256", {bundle: {url: "n.zip"}}],
    ["a malformed SHA-256", {bundle: {url: "n.zip", sha256: "abc"}}],
    ["no bundle URL", {bundle: {sha256: SHA}}],
    ["an HTTP bundle URL", {bundle: {url: "http://files.example.net/n.zip", sha256: SHA}}],
    ["a version that is not semver", {version: "latest"}],
    ["no package name", {packageName: ""}],
  ])("a manifest with %s is not_a_miniapp", async (_name, extra) => {
    expect(await resolveMiniappUrl("https://notes.acme.com/app", serve(200, manifest(extra)))).toEqual({
      ok: false,
      reason: "not_a_miniapp",
    })
  })

  test("an HTTP miniapp URL is not_a_miniapp and is not fetched", async () => {
    const seen: string[] = []
    expect(await resolveMiniappUrl("http://notes.acme.com/app", serve(200, manifest(), undefined, seen))).toEqual({
      ok: false,
      reason: "not_a_miniapp",
    })
    expect(seen).toEqual([])
  })

  test("a Mentra package name is not_a_miniapp unless served from mentraglass.com, also after redirects", async () => {
    const mentra = manifest({packageName: "com.mentra.notes"})
    expect(await resolveMiniappUrl("https://notes.acme.com/app", serve(200, mentra))).toEqual({
      ok: false,
      reason: "not_a_miniapp",
    })
    const redirectedAway = serve(200, mentra, "https://evil.example/miniapp.json")
    expect(await resolveMiniappUrl("https://apps.mentraglass.com/notes", redirectedAway)).toEqual({
      ok: false,
      reason: "not_a_miniapp",
    })
    expect(await resolveMiniappUrl("https://apps.mentraglass.com/notes", serve(200, mentra))).toMatchObject({
      ok: true,
      packageName: "com.mentra.notes",
    })
  })

  test("a manifest this Mentra App cannot run is incompatible_host", async () => {
    config = {hostVersion: "3.0.0", supportedMiniappSdkRange: "^1.0.0"}
    const body = manifest({minHostVersion: "9.0.0"})
    expect(await resolveMiniappUrl("https://notes.acme.com/app", serve(200, body))).toEqual({
      ok: false,
      reason: "incompatible_host",
    })
  })

  test.each([
    [401, "access_denied"],
    [403, "access_denied"],
    [404, "not_a_miniapp"],
    [410, "archived"],
    [503, "download_failed"],
  ] as const)("HTTP %d is %s", async (status, reason) => {
    expect(await resolveMiniappUrl("https://notes.acme.com", serve(status))).toEqual({ok: false, reason})
  })

  test("the request carries no token, and a sign-in challenge is not answered", async () => {
    const requests: RequestInit[] = []
    const challenge = (async (_url: string, init: RequestInit) => {
      requests.push(init)
      return new Response(null, {status: 401, headers: {"WWW-Authenticate": 'Bearer realm="miniapp"'}})
    }) as unknown as typeof fetch
    expect(await resolveMiniappUrl("https://notes.acme.com/app", challenge)).toEqual({
      ok: false,
      reason: "access_denied",
    })
    expect(requests).toHaveLength(1)
    expect(Object.keys(requests[0].headers ?? {}).map((name) => name.toLowerCase())).not.toContain("authorization")
  })

  test("a page that is not a miniapp manifest is not_a_miniapp; a network error is download_failed", async () => {
    expect(await resolveMiniappUrl("https://x.example", serve(200, {name: "site"}))).toEqual({
      ok: false,
      reason: "not_a_miniapp",
    })
    const offline = (async () => {
      throw new TypeError("Network request failed")
    }) as unknown as typeof fetch
    expect(await resolveMiniappUrl("https://x.example", offline)).toEqual({ok: false, reason: "download_failed"})
  })
})

describe("the domain rule", () => {
  test("a name its URL's domain doesn't own is not_a_miniapp, also after a redirect to another domain", async () => {
    expect(
      await resolveMiniappUrl("https://notes.acme.com/app", serve(200, manifest({packageName: "com.other.notes"}))),
    ).toEqual({ok: false, reason: "not_a_miniapp"})
    const redirectedAway = serve(200, manifest(), "https://notes.other.com/miniapp.json")
    expect(await resolveMiniappUrl("https://notes.acme.com/app", redirectedAway)).toEqual({
      ok: false,
      reason: "not_a_miniapp",
    })
  })

  test("a local-network URL is not_a_miniapp and is not fetched", async () => {
    const seen: string[] = []
    expect(await resolveMiniappUrl("https://10.0.0.5/app", serve(200, manifest(), undefined, seen))).toEqual({
      ok: false,
      reason: "not_a_miniapp",
    })
    expect(seen).toEqual([])
  })

  // The vectors Core's tests read too, so both refuse the same names.
  test.each(
    domainRuleVectors()
      .filter((vector) => normalizeMiniappUrl(vector.url)?.kind === "public")
      .map((vector) => [vector.packageName, vector.url, vector.allowed] as const),
  )("%p from %p resolves: %p", async (packageName, url, allowed) => {
    const result = await resolveMiniappUrl(url, serve(200, manifest({packageName})))
    expect(result.ok).toBe(allowed)
    if (!result.ok) expect(result.reason).toBe("not_a_miniapp")
  })
})
