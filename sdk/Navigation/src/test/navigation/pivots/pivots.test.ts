/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {MiniappStreamType, type StartNavigationOptions} from "@mentra/miniapp"

import {connectedSession, pushEvent} from "../helpers"

import startInputJson from "./fixtures/start.input.json"
import routeWithTurn from "./fixtures/route-with-turn.event.json"

const startInput = startInputJson as StartNavigationOptions

describe("navigation.pivots", () => {
  test("getPivots is empty before any onRoute event", async () => {
    const {session} = await connectedSession({location: true})
    void session.navigation.start(startInput)
    expect(session.navigation.getPivots()).toEqual([])
  })

  test("getActivePivot is null when no trip is running", async () => {
    const {session} = await connectedSession({location: true})
    expect(session.navigation.getActivePivot()).toBeNull()
  })

  test("getUpcomingPivot is null when no trip is running", async () => {
    const {session} = await connectedSession({location: true})
    expect(session.navigation.getUpcomingPivot()).toBeNull()
  })

  test("stop() clears the pivot list and active pivot", async () => {
    const {session, transport} = await connectedSession({location: true})
    void session.navigation.start(startInput)
    pushEvent(transport, MiniappStreamType.NAVIGATION_ROUTE, routeWithTurn)
    session.navigation.stop()

    expect(session.navigation.getPivots()).toEqual([])
    expect(session.navigation.getActivePivot()).toBeNull()
  })
})
