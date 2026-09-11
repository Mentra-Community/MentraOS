/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"
import {getMdnsHostname, pickLanIp, scoreLanIface, type LanIface} from "./lan.js"
import os from "os"

function iface(partial: Partial<LanIface> & Pick<LanIface, "name" | "address">): LanIface {
  return {
    family: "IPv4",
    internal: false,
    netmask: "255.255.255.0",
    mac: "aa:bb:cc:dd:ee:ff",
    ...partial,
  }
}

describe("scoreLanIface", () => {
  test("rejects internal, link-local, and tunnel names", () => {
    expect(scoreLanIface(iface({name: "lo0", address: "127.0.0.1", internal: true}))).toBeLessThan(0)
    expect(scoreLanIface(iface({name: "en0", address: "169.254.1.2"}))).toBeLessThan(0)
    expect(scoreLanIface(iface({name: "utun0", address: "10.137.68.90", netmask: "255.0.0.0", mac: "00:00:00:00:00:00"}))).toBeLessThan(
      0,
    )
    expect(scoreLanIface(iface({name: "tailscale0", address: "100.64.1.2"}))).toBeLessThan(0)
  })

  test("prefers en0 Wi-Fi over a leftover /8 tunnel-shaped address", () => {
    const wifi = scoreLanIface(iface({name: "en0", address: "192.168.50.252"}))
    const tunnel = scoreLanIface(
      iface({name: "en5", address: "10.0.0.2", netmask: "255.0.0.0", mac: "00:00:00:00:00:00"}),
    )
    expect(wifi).toBeGreaterThan(0)
    expect(wifi).toBeGreaterThan(tunnel)
  })
})

describe("pickLanIp", () => {
  test("picks Wi-Fi when a VPN utun is also present", () => {
    const ip = pickLanIp({
      lo0: [iface({name: "lo0", address: "127.0.0.1", internal: true})],
      en0: [iface({name: "en0", address: "192.168.50.252"})],
      utun0: [iface({name: "utun0", address: "10.137.68.90", netmask: "255.0.0.0", mac: "00:00:00:00:00:00"})],
    })
    expect(ip).toBe("192.168.50.252")
  })

  test("prefers 192.168 Wi-Fi over a first-listed 10.x tunnel-like iface", () => {
    // Object key order would have returned 10.x first with the old naive picker.
    const ip = pickLanIp({
      utun2: [iface({name: "utun2", address: "10.1.2.3", netmask: "255.0.0.0", mac: "00:00:00:00:00:00"})],
      en0: [iface({name: "en0", address: "192.168.3.162"})],
    })
    expect(ip).toBe("192.168.3.162")
  })

  test("returns null when only loopback exists", () => {
    expect(
      pickLanIp({
        lo0: [iface({name: "lo0", address: "127.0.0.1", internal: true})],
      }),
    ).toBeNull()
  })
})

describe("getMdnsHostname first label", () => {
  test("strips DNS suffixes before appending .local", () => {
    const original = os.hostname
    ;(os as {hostname: () => string}).hostname = () => "mba.corp.example.com"
    try {
      expect(getMdnsHostname()).toBe("mba.local")
    } finally {
      ;(os as {hostname: typeof original}).hostname = original
    }
  })
})

describe("scoreLanIface Linux predictable names", () => {
  test("ranks wlp*/enp* as real adapters", () => {
    const wifi = scoreLanIface(iface({name: "wlp3s0", address: "192.168.1.40"}))
    const eth = scoreLanIface(iface({name: "enp0s3", address: "192.168.1.41"}))
    expect(wifi).toBeGreaterThan(50)
    expect(eth).toBeGreaterThan(50)
  })
})
