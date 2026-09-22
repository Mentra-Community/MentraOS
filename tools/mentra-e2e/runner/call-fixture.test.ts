import {expect, test} from "bun:test"
import {hasInterfaceRoute, parseCallBuild, parseCallFixture, verifyCallDevice} from "./call-fixture"

const input = {
  schemaVersion: 1,
  glasses: {
    serial: "ML_TEST",
    usb: "123X",
    cid: "1".repeat(32),
    firmware: "MentraLive_20260915.0",
    slot: "_b",
    bluetooth: "CC:E7:DE:E0:12:34",
  },
  network: {wifiInterface: "en0", ethernetInterface: "en10"},
  cleanup: {porterApp: "qa-call", project: "123", cluster: "456", target: "qa-target"},
}

test("replay requires a declared test-adapter build with content hashes and an absolute installation", () => {
  const build = {
    bundleId: "com.mentra.mentra",
    networkAdapter: "mac-host-verified-test-only",
    launchPath: "/test/Mentra.app",
    executableSha256: "a".repeat(64),
    javascriptSha256: "b".repeat(64),
  }
  expect(parseCallBuild(build).launchPath).toBe("/test/Mentra.app")
  expect(() => parseCallBuild({...build, networkAdapter: "production"})).toThrow("test-adapter")
  expect(() => parseCallBuild({...build, launchPath: "relative/Mentra.app"})).toThrow("absolute")
  expect(() => parseCallBuild({...build, javascriptSha256: ""})).toThrow("hash")
})

test("fixture requires exact hardware identity and separate network interfaces", () => {
  expect(parseCallFixture(input).glasses.serial).toBe("ML_TEST")
  expect(() => parseCallFixture({...input, glasses: {...input.glasses, cid: ""}})).toThrow("CID")
  expect(() => parseCallFixture({...input, glasses: {...input.glasses, serial: "0123456789ABCDEF"}})).toThrow("generic")
  expect(() => parseCallFixture({...input, network: {wifiInterface: "en0", ethernetInterface: "en0"}})).toThrow(
    "separate",
  )
  expect(() => parseCallFixture({...input, cleanup: {...input.cleanup, project: "1 --other"}})).toThrow("project")
})

test("pin the current boot for each run and reject a reboot or replacement device", () => {
  const fixture = parseCallFixture(input)
  const boot = "11111111-2222-3333-4444-555555555555"
  const observed = {...fixture.glasses, bootId: boot}
  expect(verifyCallDevice(fixture.glasses, observed)).toBe(boot)
  expect(verifyCallDevice(fixture.glasses, observed, boot)).toBe(boot)
  const cid = "abcdef0123456789abcdef0123456789"
  expect(verifyCallDevice({...fixture.glasses, cid}, {...observed, cid: cid.toUpperCase()}, boot)).toBe(boot)
  expect(() => verifyCallDevice(fixture.glasses, {...observed, cid: ""}, boot)).toThrow("cid")
  expect(() => verifyCallDevice(fixture.glasses, {...observed, cid: "2".repeat(32)}, boot)).toThrow("cid")
  expect(() =>
    verifyCallDevice(fixture.glasses, {...observed, bootId: "22222222-2222-3333-4444-555555555555"}, boot),
  ).toThrow("rebooted")
})

test("a similarly prefixed network interface is not the required route", () => {
  expect(hasInterfaceRoute("  interface: en10\n", "en10")).toBe(true)
  expect(hasInterfaceRoute("  interface: en100\n", "en10")).toBe(false)
})
