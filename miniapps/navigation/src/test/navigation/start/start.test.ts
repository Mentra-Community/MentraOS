/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"
import type {MiniappSession, StartNavigationOptions} from "@mentra/miniapp"

import {ackLatest, connectedSession, type FakeTransport, lastEnvelope, lastOutbound} from "../helpers"

import v1ShorthandInput from "./fixtures/v1-shorthand.input.json"
import v1ShorthandExpected from "./fixtures/v1-shorthand.expected.json"
import multiStopInput from "./fixtures/multi-stop.input.json"
import multiStopExpected from "./fixtures/multi-stop.expected.json"
import defaultsInput from "./fixtures/defaults.input.json"
import defaultsExpected from "./fixtures/defaults.expected.json"
import simulateInput from "./fixtures/simulate.input.json"
import simulateExpected from "./fixtures/simulate.expected.json"
import avoidInput from "./fixtures/avoid.input.json"
import avoidExpected from "./fixtures/avoid.expected.json"
import twoWheelerInput from "./fixtures/two-wheeler.input.json"
import twoWheelerExpected from "./fixtures/two-wheeler.expected.json"
import accepted from "./fixtures/accepted.response.json"
import hostError from "./fixtures/host-error.response.json"

const computedRoute = {
  ok: true,
  routes: [
    {
      points: [
        {lat: 0, lng: 0},
        {lat: 1, lng: 1},
      ],
      totalDistanceMeters: 100,
      totalDurationSeconds: 60,
      steps: [
        {
          lat: 0,
          lng: 0,
          endLat: 1,
          endLng: 1,
          distanceMeters: 100,
          maneuver: "ARRIVE",
          instruction: "Arrive at the destination",
        },
      ],
    },
  ],
}

/** Advance the modern start flow through GPS + REST so NAVIGATION_START is latest. */
async function advanceToNativeStart(
  session: MiniappSession,
  transport: FakeTransport,
  options: StartNavigationOptions,
) {
  const promise = session.navigation.start(options)
  await Promise.resolve()
  expect(lastOutbound(transport).type).toBe("miniapp_location_poll")
  ackLatest(transport, {lat: 0, lng: 0, timestamp: Date.now()})
  await Promise.resolve()
  await Promise.resolve()
  expect(lastOutbound(transport).type).toBe("miniapp_navigation_compute_route")
  ackLatest(transport, computedRoute)
  await Promise.resolve()
  await Promise.resolve()
  expect(lastOutbound(transport).type).toBe("miniapp_navigation_start")
  return {promise}
}

describe("navigation.start", () => {
  test("resolves with {ok: false, error: ...} when LOCATION not declared", async () => {
    const {session} = await connectedSession({location: false})
    const result = await session.navigation.start({lat: 1, lng: 2})
    expect(result.ok).toBe(false)
    expect((result as {error?: string}).error).toMatch(/LOCATION permission not declared/)
  })

  test("v1 {lat, lng} shorthand rewrites to a single-element stops array", async () => {
    const {session, transport} = await connectedSession({location: true})
    await advanceToNativeStart(session, transport, v1ShorthandInput)
    const payload = lastOutbound(transport)
    expect(payload).toMatchObject(v1ShorthandExpected)
  })

  test("multi-stop trips serialize stops verbatim and mirror first stop into lat/lng", async () => {
    const {session, transport} = await connectedSession({location: true})
    await advanceToNativeStart(session, transport, multiStopInput as never)
    const payload = lastOutbound(transport)
    expect(payload).toMatchObject(multiStopExpected)
  })

  test("mode defaults to driving, simulate defaults to false, speedMultiplier defaults to 1", async () => {
    const {session, transport} = await connectedSession({location: true})
    await advanceToNativeStart(session, transport, defaultsInput)
    const payload = lastOutbound(transport)
    expect(payload).toMatchObject(defaultsExpected)
  })

  test("simulate options pass through unchanged", async () => {
    const {session, transport} = await connectedSession({location: true})
    await advanceToNativeStart(session, transport, simulateInput)
    const payload = lastOutbound(transport)
    expect(payload).toMatchObject(simulateExpected)
  })

  test("avoid flags serialize verbatim", async () => {
    const {session, transport} = await connectedSession({location: true})
    await advanceToNativeStart(session, transport, avoidInput)
    const payload = lastOutbound(transport)
    expect(payload).toMatchObject(avoidExpected)
  })

  test("two_wheeler mode survives the wire", async () => {
    const {session, transport} = await connectedSession({location: true})
    await advanceToNativeStart(session, transport, twoWheelerInput as never)
    const payload = lastOutbound(transport)
    expect(payload).toMatchObject(twoWheelerExpected)
  })

  test("request carries a requestId so the ack can resolve", async () => {
    const {session, transport} = await connectedSession({location: true})
    await advanceToNativeStart(session, transport, {lat: 1, lng: 2})
    expect(lastEnvelope(transport).requestId).toBeDefined()
  })

  test("resolves with the host ack on success", async () => {
    const {session, transport} = await connectedSession({location: true})
    const {promise} = await advanceToNativeStart(session, transport, {lat: 1, lng: 2})
    ackLatest(transport, accepted)
    await expect(promise).resolves.toEqual(accepted)
  })

  test("forwards host-side error in the ack", async () => {
    const {session, transport} = await connectedSession({location: true})
    const {promise} = await advanceToNativeStart(session, transport, {lat: 1, lng: 2})
    ackLatest(transport, hostError)
    await expect(promise).resolves.toEqual(hostError)
  })
})
