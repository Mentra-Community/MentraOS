/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import type {NavState} from "@mentra/miniapp"

import {ackLatest, connectedSession, lastEnvelope} from "../helpers"

import requestShape from "./fixtures/request.expected.json"
import noTrip from "./fixtures/no-trip.response.json"
import missingState from "./fixtures/missing-state.response.json"
import activeTripJson from "./fixtures/active-trip.response.json"

const activeTrip = activeTripJson as {ok: boolean; state: NavState}

describe("navigation.getState", () => {
  test("emits NAVIGATION_GET_STATE request", async () => {
    const {session, transport} = await connectedSession({location: true})
    void session.navigation.getState()
    expect(lastEnvelope(transport).payload).toMatchObject(requestShape)
  })

  test("returns null when host responds with ok: false", async () => {
    const {session, transport} = await connectedSession({location: true})
    const promise = session.navigation.getState()
    ackLatest(transport, noTrip)
    await expect(promise).resolves.toBeNull()
  })

  test("returns null when host returns ok but no state field", async () => {
    const {session, transport} = await connectedSession({location: true})
    const promise = session.navigation.getState()
    ackLatest(transport, missingState)
    await expect(promise).resolves.toBeNull()
  })

  test("hydrates the full NavState snapshot when active", async () => {
    const {session, transport} = await connectedSession({location: true})
    const promise = session.navigation.getState()
    ackLatest(transport, activeTrip)
    await expect(promise).resolves.toEqual(activeTrip.state)
  })
})
