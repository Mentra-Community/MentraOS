/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {createStreamPreviewSource} from "../streamPreviewMeetingSource"

type Owned = {ownerPackage: string; instanceId: string}

function provider() {
  const listeners = new Set<(instanceId: string) => void>()
  return {
    value: null as Owned | null,
    current(): Owned | null {
      return this.value
    },
    onReleased(listener: (instanceId: string) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    release(instanceId: string) {
      for (const listener of [...listeners]) listener(instanceId)
    },
    listenerCount: () => listeners.size,
  }
}

function setup() {
  const acs = provider()
  const relay = provider()
  return {acs, relay, source: createStreamPreviewSource({acs, relay})}
}

describe("createStreamPreviewSource", () => {
  test("nothing to preview when there is neither a meeting nor a relay", () => {
    expect(setup().source.current("com.call")).toBeNull()
  })

  test("the meeting owner previews the meeting through the acs decoder", () => {
    const {acs, source} = setup()
    acs.value = {ownerPackage: "com.call", instanceId: "acs-1"}
    expect(source.current("com.call")).toEqual({ownerPackage: "com.call", instanceId: "acs-1", origin: "acs"})
  })

  test("the relay owner previews the relay when it owns no meeting", () => {
    const {relay, source} = setup()
    relay.value = {ownerPackage: "com.call", instanceId: "relay-m-1"}
    expect(source.current("com.call")).toEqual({ownerPackage: "com.call", instanceId: "relay-m-1", origin: "relay"})
  })

  test("the meeting wins when one package owns both", () => {
    const {acs, relay, source} = setup()
    relay.value = {ownerPackage: "com.call", instanceId: "relay-m-1"}
    acs.value = {ownerPackage: "com.call", instanceId: "acs-1"}
    expect(source.current("com.call")?.origin).toBe("acs")
  })

  test("a package is never given another package's source", () => {
    const {acs, relay, source} = setup()
    acs.value = {ownerPackage: "com.call", instanceId: "acs-1"}
    relay.value = {ownerPackage: "com.call", instanceId: "relay-m-1"}
    expect(source.current("com.other")).toBeNull()
  })

  test("another package's meeting does not hide a package's own relay", () => {
    const {acs, relay, source} = setup()
    acs.value = {ownerPackage: "com.other", instanceId: "acs-1"}
    relay.value = {ownerPackage: "com.call", instanceId: "relay-m-1"}
    expect(source.current("com.call")).toEqual({ownerPackage: "com.call", instanceId: "relay-m-1", origin: "relay"})
    expect(source.current("com.other")?.origin).toBe("acs")
  })

  test("a release from either provider reaches the listener, and unsubscribing stops both", () => {
    const {acs, relay, source} = setup()
    const released: string[] = []
    const off = source.onReleased((id) => released.push(id))
    acs.release("acs-1")
    relay.release("relay-m-1")
    expect(released).toEqual(["acs-1", "relay-m-1"])
    off()
    acs.release("acs-2")
    relay.release("relay-m-2")
    expect(released).toEqual(["acs-1", "relay-m-1"])
    expect(acs.listenerCount() + relay.listenerCount()).toBe(0)
  })
})
