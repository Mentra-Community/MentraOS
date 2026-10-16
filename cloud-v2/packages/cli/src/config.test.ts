import {expect, test} from "bun:test"

import {isLoopbackHttp, normalizeUrl} from "./config"

test("plain HTTP is accepted only to this machine: 127.0.0.1, localhost and [::1]", () => {
  // The URL parser keeps an IPv6 hostname's brackets, so "[::1]" is what the check sees.
  expect(new URL("http://[::1]:3003/").hostname).toBe("[::1]")
  for (const url of ["http://127.0.0.1:3003", "http://localhost:3003", "http://[::1]:3003"]) {
    expect(isLoopbackHttp(new URL(url))).toBe(true)
    expect(normalizeUrl(`${url}/`, "MENTRA_STORE_URL")).toBe(url)
  }
  for (const url of ["http://[::2]:3003", "http://127.0.0.2:3003", "http://store.example", "http://localhost.example"]) {
    expect(isLoopbackHttp(new URL(url))).toBe(false)
    expect(() => normalizeUrl(url, "MENTRA_STORE_URL")).toThrow("must be an HTTPS URL")
  }
  expect(normalizeUrl("https://api.apps.mentraglass.com/", "MENTRA_STORE_URL")).toBe("https://api.apps.mentraglass.com")
})
