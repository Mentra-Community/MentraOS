/// <reference types="bun-types" />
/**
 * Asserts road names survive the bridge end-to-end: when the host emits a
 * NavRoute with step metadata, an onRoute subscriber sees every `step.road`
 * in order. Drops nulls (unnamed paths), keeps consecutive duplicates.
 */
import {describe, expect, test} from "bun:test"

import {MiniappStreamType} from "@mentra/miniapp"
import type {NavRoute, NavStep} from "@mentra/miniapp"

import {connectedSession, pushEvent} from "../helpers"

import simpleRoute from "./fixtures/simple-route.event.json"
import simpleExpected from "./fixtures/simple-route.expected.json"
import withNullsRoute from "./fixtures/with-nulls.event.json"
import withNullsExpected from "./fixtures/with-nulls.expected.json"
import duplicatesRoute from "./fixtures/duplicates.event.json"
import duplicatesExpected from "./fixtures/duplicates.expected.json"
import emptyStepsRoute from "./fixtures/empty-steps.event.json"
import emptyStepsExpected from "./fixtures/empty-steps.expected.json"

function getRoadNames(route: NavRoute): string[] {
  const steps: NavStep[] = route.steps ?? []
  return steps
    .map((s) => s.road)
    .filter((r): r is string => typeof r === "string" && r.length > 0)
}

describe("road names from a NavRoute", () => {
  test("extracts every named road in order", async () => {
    const {session, transport} = await connectedSession({location: true})
    let received: NavRoute | null = null
    session.navigation.onRoute((r) => {
      received = r
    })

    pushEvent(transport, MiniappStreamType.NAVIGATION_ROUTE, simpleRoute)
    expect(received).not.toBeNull()
    expect(getRoadNames(received!)).toEqual(simpleExpected.roadNames)
  })

  test("drops null / missing road names (unnamed paths)", async () => {
    const {session, transport} = await connectedSession({location: true})
    let received: NavRoute | null = null
    session.navigation.onRoute((r) => {
      received = r
    })

    pushEvent(transport, MiniappStreamType.NAVIGATION_ROUTE, withNullsRoute)
    expect(getRoadNames(received!)).toEqual(withNullsExpected.roadNames)
  })

  test("keeps consecutive duplicates (same road across steps)", async () => {
    const {session, transport} = await connectedSession({location: true})
    let received: NavRoute | null = null
    session.navigation.onRoute((r) => {
      received = r
    })

    pushEvent(transport, MiniappStreamType.NAVIGATION_ROUTE, duplicatesRoute)
    expect(getRoadNames(received!)).toEqual(duplicatesExpected.roadNames)
  })

  test("returns empty array when the route has no steps", async () => {
    const {session, transport} = await connectedSession({location: true})
    let received: NavRoute | null = null
    session.navigation.onRoute((r) => {
      received = r
    })

    pushEvent(transport, MiniappStreamType.NAVIGATION_ROUTE, emptyStepsRoute)
    expect(getRoadNames(received!)).toEqual(emptyStepsExpected.roadNames)
  })
})
