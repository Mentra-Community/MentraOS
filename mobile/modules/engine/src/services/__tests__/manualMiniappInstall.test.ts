import {afterAll, beforeEach, expect, mock, test} from "bun:test"

import "./reactNativeTestMock"

// A release QR names no domain that could own its package name, so it installs as a local build.
let installs: Array<{bundleUrl: string; install: Record<string, unknown>}>
let failInstall: Error | undefined
mock.module("../localBuildInstall", () => ({
  installLocalBuild: async (bundleUrl: string, install: Record<string, unknown>) => {
    installs.push({bundleUrl, install})
    if (failInstall) throw failInstall
  },
}))
const {installMiniappFromJsonUrl} = await import("../manualMiniappInstall")
const originalFetch = globalThis.fetch
let manifest: Record<string, unknown>

beforeEach(() => {
  installs = []
  failInstall = undefined
  manifest = {packageName: "com.mentra.notes", version: "2.0.0", name: "Notes"}
  globalThis.fetch = (async () => new Response(JSON.stringify(manifest))) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = originalFetch
})

test("a release QR installs the build it shows as a local build of its package, at its address", async () => {
  const result = await installMiniappFromJsonUrl("http://192.168.1.20:6789/")
  expect(result.is_ok() && result.value).toEqual({packageName: "com.mentra.notes", version: "2.0.0", name: "Notes"})
  expect(installs).toEqual([
    {
      bundleUrl: "http://192.168.1.20:6789/bundle.zip",
      install: {packageName: "com.mentra.notes", version: "2.0.0", sourceUrl: "http://192.168.1.20:6789/"},
    },
  ])
})

test("any address a release QR names installs as a local build", async () => {
  expect((await installMiniappFromJsonUrl("https://lan.example:6789")).is_ok()).toBe(true)
  expect(installs.map(({bundleUrl, install}) => [bundleUrl, install.sourceUrl])).toEqual([
    ["https://lan.example:6789/bundle.zip", "https://lan.example:6789/"],
  ])
})

test("a refused bundle is the install's error", async () => {
  failInstall = new Error("Publisher signature mismatch for installed miniapp com.mentra.notes")
  const result = await installMiniappFromJsonUrl("http://192.168.1.20:6789")
  expect(result.is_error() && result.error.message).toContain("Publisher signature mismatch")
})

test("a manifest without an identity is rejected before any install", async () => {
  manifest = {name: "Nameless"}
  const result = await installMiniappFromJsonUrl("http://192.168.1.20:6789")
  expect(result.is_error() && result.error.message).toContain("missing packageName")
  expect(installs).toEqual([])
})
