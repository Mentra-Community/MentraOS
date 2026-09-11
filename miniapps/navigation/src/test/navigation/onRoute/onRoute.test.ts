/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {MiniappStreamType} from "@mentra/miniapp"

import {connectedSession, pushEvent} from "../helpers"

import fullRoute from "./fixtures/full-route.event.json"
import reroute from "./fixtures/reroute.events.json"

describe("navigation.onRoute", () => {
  test("delivers the full NavRoute payload to subscribers", async () => {
    const {session, transport} = await connectedSession({location: true})
    const received: Record<string, unknown>[] = []
    session.navigation.onRoute((r) => {
      received.push(r as Record<string, unknown>)
    })

    pushEvent(transport, MiniappStreamType.NAVIGATION_ROUTE, fullRoute)
    expect(received[0]).toEqual(fullRoute)
  })

  test("a reroute fires onRoute again with the full new polyline", async () => {
    const {session, transport} = await connectedSession({location: true})
    const received: Array<{points: unknown}> = []
    session.navigation.onRoute((r) => received.push(r as {points: unknown}))

    for (const event of reroute) {
      pushEvent(transport, MiniappStreamType.NAVIGATION_ROUTE, event)
    }

    expect(received).toHaveLength(reroute.length)
    expect((received[1]!.points as unknown[]).length).toBe((reroute[1]!.points as unknown[]).length)
  })

  test("unsubscribe stops further deliveries", async () => {
    const {session, transport} = await connectedSession({location: true})
    let count = 0
    const unsub = session.navigation.onRoute(() => {
      count++
    })

    pushEvent(transport, MiniappStreamType.NAVIGATION_ROUTE, {points: []})
    unsub()
    pushEvent(transport, MiniappStreamType.NAVIGATION_ROUTE, {points: []})

    expect(count).toBe(1)
  })
})
