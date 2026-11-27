/// <reference types="bun-types" />

import {beforeEach, describe, expect, test} from "bun:test"

import {MemoryFleetStore} from "../fleet/__tests__/memoryFleetStore"
import {selectInstallTarget} from "../miniappInstallTarget"
import {createMiniappPins, MINIAPP_PIN_STORE_PREFIX, type FleetMiniappPin, type MiniappPins} from "../miniappPins"

const pkg = "com.acme.notes"
const LATEST = "a".repeat(64)
const OLD = "b".repeat(64)

function fleetPin(version: string, sha256: string): FleetMiniappPin {
  return {
    version,
    sha256,
    assignmentId: "asg_1",
    assignmentRevision: 3,
    workspaceId: "ws_1",
    coreUrl: "https://core.example.com",
    mentraUserId: "mu_1",
    url: "https://notes.acme.com/app/",
  }
}

let store: MemoryFleetStore
let pins: MiniappPins

beforeEach(() => {
  store = new MemoryFleetStore()
  pins = createMiniappPins(() => store)
})

describe("the pin record", () => {
  test("holds a Fleet pin with its assignment, per package, with nothing installed", () => {
    expect(pins.pinFor(pkg)).toBeNull()
    pins.setFleetPin(pkg, fleetPin("1.5.0", OLD))
    expect(pins.pinFor(pkg)).toEqual({version: "1.5.0", sha256: OLD})
    expect(pins.record(pkg)).toEqual({fleet: fleetPin("1.5.0", OLD)})
    expect(pins.pinFor("com.acme.other")).toBeNull()
    expect(pins.fleetPinnedPackages()).toEqual([pkg])
  })

  test("persists in the store it is given, so a new process reads it", () => {
    pins.setFleetPin(pkg, fleetPin("1.5.0", OLD))
    const again = createMiniappPins(() => new MemoryFleetStore(store.values))
    expect(again.pinFor(pkg)).toEqual({version: "1.5.0", sha256: OLD})
  })

  test("clearing the Fleet pin removes the record, and keeps a person's pin", () => {
    pins.setFleetPin(pkg, fleetPin("1.5.0", OLD))
    pins.setFleetPin(pkg, null)
    expect(pins.record(pkg)).toBeNull()
    expect(store.values.has(`${MINIAPP_PIN_STORE_PREFIX}${pkg}`)).toBe(false)

    // Nothing writes a person's pin yet; the slot is read, and a Fleet pin wins over it.
    store.set(`${MINIAPP_PIN_STORE_PREFIX}${pkg}`, JSON.stringify({person: {version: "1.0.0", sha256: LATEST}}))
    expect(pins.pinFor(pkg)).toEqual({version: "1.0.0", sha256: LATEST})
    expect(pins.fleetPinnedPackages()).toEqual([])
    pins.setFleetPin(pkg, fleetPin("1.5.0", OLD))
    expect(pins.pinFor(pkg)).toEqual({version: "1.5.0", sha256: OLD})
    pins.setFleetPin(pkg, null)
    expect(pins.record(pkg)).toEqual({person: {version: "1.0.0", sha256: LATEST}})
  })

  test("a record that can't be read is no pin, and a store that fails never throws", () => {
    store.set(`${MINIAPP_PIN_STORE_PREFIX}${pkg}`, "{not json")
    expect(pins.pinFor(pkg)).toBeNull()
    store.set(`${MINIAPP_PIN_STORE_PREFIX}${pkg}`, JSON.stringify({fleet: {version: "1.5.0", sha256: "nothex"}}))
    expect(pins.pinFor(pkg)).toBeNull()
    store.failSetWhen = () => true
    expect(() => pins.setFleetPin(pkg, fleetPin("1.5.0", OLD))).not.toThrow()
    store.failGetAllKeys = true
    expect(pins.fleetPinnedPackages()).toEqual([])
  })

  test("a hash is kept in lowercase", () => {
    pins.setFleetPin(pkg, fleetPin("1.5.0", OLD.toUpperCase()))
    expect(pins.pinFor(pkg)).toEqual({version: "1.5.0", sha256: OLD})
  })
})

describe("the install target", () => {
  const served = {
    version: "2.0.0",
    bundle: {url: "notes-2.0.0.zip", sha256: LATEST},
    versions: [
      {version: "2.0.0", url: "notes-2.0.0.zip", sha256: LATEST},
      {version: "1.5.0", url: "notes-1.5.0.zip", sha256: OLD},
    ],
  }

  test("without a pin it is bundle, the latest build", () => {
    expect(selectInstallTarget(pkg, served, pins.pinFor)).toEqual({
      ok: true,
      build: {version: "2.0.0", url: "notes-2.0.0.zip", sha256: LATEST},
      pinned: false,
    })
  })

  test("with a pin it is the pinned version's entry, an older one included (a rollback)", () => {
    pins.setFleetPin(pkg, fleetPin("1.5.0", OLD))
    expect(selectInstallTarget(pkg, served, pins.pinFor)).toEqual({
      ok: true,
      build: {version: "1.5.0", url: "notes-1.5.0.zip", sha256: OLD},
      pinned: true,
    })
  })

  test("a pin to the latest version is met by its entry", () => {
    pins.setFleetPin(pkg, fleetPin("2.0.0", LATEST))
    expect(selectInstallTarget(pkg, served, pins.pinFor)).toEqual({
      ok: true,
      build: {version: "2.0.0", url: "notes-2.0.0.zip", sha256: LATEST},
      pinned: true,
    })
  })

  test("a version that isn't listed, or no list at all, is pin_unlisted", () => {
    pins.setFleetPin(pkg, fleetPin("1.4.0", OLD))
    expect(selectInstallTarget(pkg, served, pins.pinFor)).toEqual({
      ok: false,
      reason: "pin_unlisted",
      pin: {version: "1.4.0", sha256: OLD},
    })
    pins.setFleetPin(pkg, fleetPin("2.0.0", LATEST))
    const {versions: _none, ...unlisted} = served
    expect(selectInstallTarget(pkg, unlisted, pins.pinFor)).toMatchObject({ok: false, reason: "pin_unlisted"})
  })

  test("a listed version whose hash isn't the pin's is pin_hash_changed", () => {
    pins.setFleetPin(pkg, fleetPin("1.5.0", "c".repeat(64)))
    expect(selectInstallTarget(pkg, served, pins.pinFor)).toMatchObject({ok: false, reason: "pin_hash_changed"})
  })

  test("with no reader a pin has no effect", () => {
    pins.setFleetPin(pkg, fleetPin("1.5.0", OLD))
    expect(selectInstallTarget(pkg, served, null)).toMatchObject({ok: true, pinned: false, build: {version: "2.0.0"}})
  })
})
