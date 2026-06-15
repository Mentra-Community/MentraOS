/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {MiniappStreamType} from "@mentra/miniapp"

import {connectedSession, pushEvent} from "../helpers"

import allKinds from "./fixtures/all-kinds.events.json"
import maneuverPayload from "./fixtures/maneuver-payload.events.json"

describe("navigation.onUpdate", () => {
  test("fans out maneuver / off_route / rerouting / arrived / error", async () => {
    const {session, transport} = await connectedSession({location: true})
    const received: Array<{kind: string}> = []
    session.navigation.onUpdate((u) => received.push(u as {kind: string}))

    for (const data of allKinds) {
      pushEvent(transport, MiniappStreamType.NAVIGATION_UPDATE, data)
    }

    expect(received.map((u) => u.kind)).toEqual(allKinds.map((u) => u.kind))
  })

  test("preserves NavManeuver field shape end-to-end", async () => {
    const {session, transport} = await connectedSession({location: true})
    const received: Record<string, unknown>[] = []
    session.navigation.onUpdate((u) => {
      received.push(u as Record<string, unknown>)
    })

    pushEvent(transport, MiniappStreamType.NAVIGATION_UPDATE, maneuverPayload)
    expect(received[0]).toEqual(maneuverPayload)
  })

  test("unsubscribe stops further deliveries", async () => {
    const {session, transport} = await connectedSession({location: true})
    const received: Array<{kind: string}> = []
    const unsub = session.navigation.onUpdate((u) => received.push(u as {kind: string}))

    pushEvent(transport, MiniappStreamType.NAVIGATION_UPDATE, {kind: "rerouting"})
    unsub()
    pushEvent(transport, MiniappStreamType.NAVIGATION_UPDATE, {kind: "arrived"})

    expect(received).toHaveLength(1)
    expect(received[0]!.kind).toBe("rerouting")
  })
})
