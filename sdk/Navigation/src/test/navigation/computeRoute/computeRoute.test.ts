/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {ackLatest, connectedSession, lastOutbound} from "../helpers"

import defaultsInput from "./fixtures/defaults.input.json"
import defaultsExpected from "./fixtures/defaults.expected.json"
import passthroughInput from "./fixtures/passthrough.input.json"
import passthroughExpected from "./fixtures/passthrough.expected.json"
import primaryPlusAlts from "./fixtures/primary-plus-alternates.response.json"
import engineFailure from "./fixtures/engine-failure.response.json"

describe("navigation.computeRoute", () => {
  test("resolves with {ok: false, error: ...} when LOCATION not declared", async () => {
    const {session} = await connectedSession({location: false})
    const result = await session.navigation.computeRoute({origin: {lat: 0, lng: 0}, stops: [{lat: 1, lng: 1}]})
    expect(result.ok).toBe(false)
    expect((result as {error?: string}).error).toMatch(/LOCATION permission not declared/)
  })

  test("defaults mode to driving and alternatives to 1", async () => {
    const {session, transport} = await connectedSession({location: true})
    void session.navigation.computeRoute(defaultsInput as never)
    expect(lastOutbound(transport)).toMatchObject(defaultsExpected)
  })

  test("origin / stops / alternatives / mode pass through verbatim", async () => {
    const {session, transport} = await connectedSession({location: true})
    void session.navigation.computeRoute(passthroughInput as never)
    expect(lastOutbound(transport)).toMatchObject(passthroughExpected)
  })

  test("resolves with primary + alternates", async () => {
    const {session, transport} = await connectedSession({location: true})
    const promise = session.navigation.computeRoute({
      origin: {lat: 0, lng: 0},
      stops: [{lat: 1, lng: 1}],
      alternatives: 2,
    })
    ackLatest(transport, primaryPlusAlts)
    await expect(promise).resolves.toEqual(primaryPlusAlts)
  })

  test("forwards engine failure as ComputeRouteResult.ok=false", async () => {
    const {session, transport} = await connectedSession({location: true})
    const promise = session.navigation.computeRoute({
      origin: {lat: 0, lng: 0},
      stops: [{lat: 1, lng: 1}],
    })
    ackLatest(transport, engineFailure)
    await expect(promise).resolves.toEqual(engineFailure)
  })
})
