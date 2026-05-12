/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {MiniappErrorCode} from "@mentra/miniapp"

import {ackLatest, connectedSession, lastEnvelope, lastOutbound} from "../helpers"

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

describe("navigation.start", () => {
  test("throws PERMISSION_NOT_DECLARED when LOCATION missing", async () => {
    const {session} = await connectedSession({location: false})
    let caught: unknown
    try {
      session.navigation.start({lat: 1, lng: 2})
    } catch (e) {
      caught = e
    }
    expect((caught as {code: string}).code).toBe(MiniappErrorCode.PERMISSION_NOT_DECLARED)
  })

  test("v1 {lat, lng} shorthand rewrites to a single-element stops array", async () => {
    const {session, transport} = await connectedSession({location: true})
    void session.navigation.start(v1ShorthandInput)
    const payload = lastOutbound(transport)
    expect(payload).toMatchObject(v1ShorthandExpected)
  })

  test("multi-stop trips serialize stops verbatim and mirror first stop into lat/lng", async () => {
    const {session, transport} = await connectedSession({location: true})
    void session.navigation.start(multiStopInput as never)
    const payload = lastOutbound(transport)
    expect(payload).toMatchObject(multiStopExpected)
  })

  test("mode defaults to driving, simulate defaults to false, speedMultiplier defaults to 5", async () => {
    const {session, transport} = await connectedSession({location: true})
    void session.navigation.start(defaultsInput)
    const payload = lastOutbound(transport)
    expect(payload).toMatchObject(defaultsExpected)
  })

  test("simulate options pass through unchanged", async () => {
    const {session, transport} = await connectedSession({location: true})
    void session.navigation.start(simulateInput)
    const payload = lastOutbound(transport)
    expect(payload).toMatchObject(simulateExpected)
  })

  test("avoid flags serialize verbatim", async () => {
    const {session, transport} = await connectedSession({location: true})
    void session.navigation.start(avoidInput)
    const payload = lastOutbound(transport)
    expect(payload).toMatchObject(avoidExpected)
  })

  test("two_wheeler mode survives the wire", async () => {
    const {session, transport} = await connectedSession({location: true})
    void session.navigation.start(twoWheelerInput as never)
    const payload = lastOutbound(transport)
    expect(payload).toMatchObject(twoWheelerExpected)
  })

  test("request carries a requestId so the ack can resolve", async () => {
    const {session, transport} = await connectedSession({location: true})
    void session.navigation.start({lat: 1, lng: 2})
    expect(lastEnvelope(transport).requestId).toBeDefined()
  })

  test("resolves with the host ack on success", async () => {
    const {session, transport} = await connectedSession({location: true})
    const promise = session.navigation.start({lat: 1, lng: 2})
    ackLatest(transport, accepted)
    await expect(promise).resolves.toEqual(accepted)
  })

  test("forwards host-side error in the ack", async () => {
    const {session, transport} = await connectedSession({location: true})
    const promise = session.navigation.start({lat: 1, lng: 2})
    ackLatest(transport, hostError)
    await expect(promise).resolves.toEqual(hostError)
  })
})
