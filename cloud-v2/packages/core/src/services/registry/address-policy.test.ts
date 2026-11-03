import {describe, expect, test} from "bun:test"
import {isPublicAddress} from "./address-policy"

describe("isPublicAddress", () => {
  test("refuses every special-purpose IPv4 range", () => {
    const refused = {
      "this network": ["0.0.0.0", "0.1.2.3"],
      private: ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.255.255"],
      "carrier-grade NAT": ["100.64.0.1", "100.100.100.200", "100.127.255.255"],
      loopback: ["127.0.0.1", "127.255.255.254"],
      "link-local and instance metadata": ["169.254.0.1", "169.254.169.254", "169.254.170.2"],
      "IETF protocol assignments": ["192.0.0.1", "192.0.0.192"],
      documentation: ["192.0.2.1", "198.51.100.1", "203.0.113.1"],
      "6to4 relay anycast": ["192.88.99.1"],
      benchmarking: ["198.18.0.1", "198.19.255.255"],
      "AS112 and AMT": ["192.31.196.1", "192.52.193.1", "192.175.48.1"],
      multicast: ["224.0.0.1", "239.255.255.250"],
      "reserved and broadcast": ["240.0.0.1", "255.255.255.254", "255.255.255.255"],
      "cloud platform address": ["168.63.129.16"],
    }
    for (const [range, addresses] of Object.entries(refused)) {
      for (const address of addresses) expect({range, address, allowed: isPublicAddress(address)}).toEqual({range, address, allowed: false})
    }
  })

  test("refuses every special-purpose IPv6 range", () => {
    const refused = {
      unspecified: ["::"],
      loopback: ["::1"],
      "IPv4-compatible (deprecated)": ["::7f00:1", "::127.0.0.1", "::8.8.8.8"],
      "IPv4-translated": ["::ffff:0:7f00:1"],
      NAT64: ["64:ff9b::7f00:1", "64:ff9b::808:808", "64:ff9b:1::1"],
      discard: ["100::1"],
      "link-local": ["fe80::1", "febf:ffff::1"],
      "site-local": ["fec0::1"],
      "unique-local and instance metadata": ["fc00::1", "fd00::1", "fd00:ec2::254"],
      multicast: ["ff02::1", "ff0e::1"],
      Teredo: ["2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2"],
      "IETF protocol assignments": ["2001:1::1", "2001:2::1", "2001:10::1", "2001:20::1", "2001:30::1"],
      documentation: ["2001:db8::1", "3fff::1"],
      "6to4": ["2002:7f00:1::1", "2002:808:808::1"],
      "segment routing": ["5f00::1"],
      "outside global unicast": ["4000::1", "8000::1", "1::1"],
    }
    for (const [range, addresses] of Object.entries(refused)) {
      for (const address of addresses) expect({range, address, allowed: isPublicAddress(address)}).toEqual({range, address, allowed: false})
    }
  })

  test("judges an IPv4-mapped IPv6 address by the IPv4 address it carries", () => {
    for (const address of [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::FFFF:127.0.0.1",
      "0:0:0:0:0:ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:169.254.169.254",
      "::ffff:100.64.0.1",
      "::ffff:0.0.0.0",
      "::ffff:168.63.129.16",
    ]) {
      expect({address, allowed: isPublicAddress(address)}).toEqual({address, allowed: false})
    }
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true)
    expect(isPublicAddress("::ffff:808:808")).toBe(true)
  })

  test("allows ordinary public unicast, including the edges of refused ranges", () => {
    for (const address of [
      "1.1.1.1",
      "8.8.8.8",
      "93.184.215.14",
      "104.20.23.154",
      "9.255.255.255",
      "11.0.0.0",
      "100.63.255.255",
      "100.128.0.0",
      "126.255.255.255",
      "128.0.0.1",
      "169.253.255.255",
      "169.255.0.0",
      "172.15.255.255",
      "172.32.0.0",
      "192.167.255.255",
      "192.169.0.0",
      "168.63.129.15",
      "168.63.129.17",
      "223.255.255.255",
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "2620:fe::fe",
      "2a00:1450:4001:830::200e",
      "2001:200::1",
      "3ffe::1",
    ]) {
      expect({address, allowed: isPublicAddress(address)}).toEqual({address, allowed: true})
    }
  })

  test("refuses anything that isn't a canonical address literal", () => {
    for (const address of [
      "",
      "localhost",
      "example.com",
      "127.1",
      "127.0.1",
      "0x7f.0.0.1",
      "0x7f000001",
      "2130706433",
      "0177.0.0.1",
      "010.0.0.1",
      "1.2.3",
      "1.2.3.4.5",
      "256.1.1.1",
      " 8.8.8.8",
      "8.8.8.8 ",
      "8.8.8.8\n",
      "[2606:4700:4700::1111]",
      "2606:4700:4700::1111%eth0",
      "fe80::1%lo0",
      "2606:4700:4700:::1111",
    ]) {
      expect({address, allowed: isPublicAddress(address)}).toEqual({address, allowed: false})
    }
  })
})
