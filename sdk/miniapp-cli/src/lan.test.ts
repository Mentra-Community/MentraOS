/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, test} from "bun:test"
import {getLanIp, getMdnsHostname, pickLanIp, scoreLanIface, type LanIface} from "./lan.js"
import os from "os"

type TestLanIface = os.NetworkInterfaceInfoIPv4 & Pick<LanIface, "name">

function iface(partial: Partial<TestLanIface> & Pick<TestLanIface, "name" | "address">): TestLanIface {
  return {
    family: "IPv4",
    internal: false,
    netmask: "255.255.255.0",
    mac: "aa:bb:cc:dd:ee:ff",
    cidr: null,
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
    expect(scoreLanIface(iface({name: "awdl0", address: "10.0.0.1"}))).toBeLessThan(0)
  })

  test("keeps Tailscale as positive fallback score lower than physical Wi-Fi", () => {
    const tailscale = scoreLanIface(iface({name: "tailscale0", address: "100.64.1.2"}))
    const wifi = scoreLanIface(iface({name: "en0", address: "192.168.1.100"}))
    expect(tailscale).toBeGreaterThan(0)
    expect(wifi).toBeGreaterThan(tailscale)
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

describe("getLanIp with mocked os.networkInterfaces", () => {
  let originalNetworkInterfaces: typeof os.networkInterfaces

  function mockInterfaces(map: ReturnType<typeof os.networkInterfaces>) {
    os.networkInterfaces = () => map
  }

  beforeEach(() => {
    originalNetworkInterfaces = os.networkInterfaces
  })

  afterEach(() => {
    os.networkInterfaces = originalNetworkInterfaces
  })

  test("Case 1: Tailscale + Wi-Fi (192.168.x.x) present -> must select Wi-Fi", () => {
    mockInterfaces({
      tailscale0: [iface({name: "tailscale0", address: "100.64.1.2", netmask: "255.255.255.255"})],
      "Wi-Fi": [iface({name: "Wi-Fi", address: "192.168.1.105", netmask: "255.255.255.0"})],
    })
    expect(getLanIp()).toBe("192.168.1.105")
  })

  test("Case 2: WSL (vEthernet) + Ethernet (10.x.x.x) present -> must select Ethernet", () => {
    mockInterfaces({
      "vEthernet (WSL)": [iface({name: "vEthernet (WSL)", address: "172.28.96.1", netmask: "255.255.240.0"})],
      Ethernet: [iface({name: "Ethernet", address: "10.0.0.15", netmask: "255.255.255.0"})],
    })
    expect(getLanIp()).toBe("10.0.0.15")
  })

  test("Case 3: Only Tailscale interface present -> must fallback to Tailscale instead of returning null", () => {
    mockInterfaces({
      tailscale0: [iface({name: "tailscale0", address: "100.64.1.2", netmask: "255.255.255.255"})],
    })
    expect(getLanIp()).toBe("100.64.1.2")
  })

  test("Case 4: No non-internal IPv4 -> returns null", () => {
    mockInterfaces({
      lo0: [iface({name: "lo0", address: "127.0.0.1", internal: true})],
      linklocal: [iface({name: "en0", address: "169.254.1.2", internal: false})],
    })
    expect(getLanIp()).toBeNull()
  })
})

describe("virtual vs physical LAN regression cases (PR #4048)", () => {
  let originalNetworkInterfaces: typeof os.networkInterfaces

  function mockInterfaces(map: ReturnType<typeof os.networkInterfaces>) {
    os.networkInterfaces = () => map
  }

  beforeEach(() => {
    originalNetworkInterfaces = os.networkInterfaces
  })

  afterEach(() => {
    os.networkInterfaces = originalNetworkInterfaces
  })

  const regressionCases = [
    {
      name: "vmnet1 (192.168.56.1) vs enp0s3 (172.20.1.10) -> must select enp0s3 (172.20.1.10)",
      interfaces: {
        vmnet1: [iface({name: "vmnet1", address: "192.168.56.1", netmask: "255.255.255.0"})],
        enp0s3: [iface({name: "enp0s3", address: "172.20.1.10", netmask: "255.255.255.0"})],
      },
      expected: "172.20.1.10",
    },
    {
      name: "veth1234 (192.168.1.50) vs physical eth0 (10.0.0.5) -> must select eth0 (10.0.0.5)",
      interfaces: {
        veth1234: [iface({name: "veth1234", address: "192.168.1.50", netmask: "255.255.255.0"})],
        eth0: [iface({name: "eth0", address: "10.0.0.5", netmask: "255.255.255.0"})],
      },
      expected: "10.0.0.5",
    },
    {
      name: "ztabcdef (192.168.192.1) vs physical Wi-Fi -> must select physical Wi-Fi",
      interfaces: {
        ztabcdef: [iface({name: "ztabcdef", address: "192.168.192.1", netmask: "255.255.255.0"})],
        "Wi-Fi": [iface({name: "Wi-Fi", address: "192.168.1.100", netmask: "255.255.255.0"})],
      },
      expected: "192.168.1.100",
    },
    {
      name: "Order A: vmnet1 (192.168.56.1/24) listed before eno1 (203.0.113.42/25) -> must select eno1",
      interfaces: {
        vmnet1: [iface({name: "vmnet1", address: "192.168.56.1", netmask: "255.255.255.0"})],
        eno1: [iface({name: "eno1", address: "203.0.113.42", netmask: "255.255.255.128"})],
      },
      expected: "203.0.113.42",
    },
    {
      name: "Order B: eno1 (203.0.113.42/25) listed before vmnet1 (192.168.56.1/24) -> must select eno1",
      interfaces: {
        eno1: [iface({name: "eno1", address: "203.0.113.42", netmask: "255.255.255.128"})],
        vmnet1: [iface({name: "vmnet1", address: "192.168.56.1", netmask: "255.255.255.0"})],
      },
      expected: "203.0.113.42",
    },
  ]

  for (const tc of regressionCases) {
    test(tc.name, () => {
      mockInterfaces(tc.interfaces)
      expect(getLanIp()).toBe(tc.expected)
    })
  }

  test("when only vmnet1 is present -> returns vmnet1 as fallback", () => {
    mockInterfaces({
      vmnet1: [iface({name: "vmnet1", address: "192.168.56.1", netmask: "255.255.255.0"})],
    })
    expect(getLanIp()).toBe("192.168.56.1")
  })

  test("when only tailscale0 is present -> returns tailscale0 as fallback", () => {
    mockInterfaces({
      tailscale0: [iface({name: "tailscale0", address: "100.64.1.2", netmask: "255.255.255.255"})],
    })
    expect(getLanIp()).toBe("100.64.1.2")
  })
})
