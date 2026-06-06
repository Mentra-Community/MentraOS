/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {ackLatest, connectedSession, lastEnvelope} from "../helpers"

import emitRequest from "./fixtures/emit-request.expected.json"
import androidAccepted from "./fixtures/android-accepted.response.json"
import iosNotSupported from "./fixtures/ios-not-supported.response.json"

describe("navigation.requestPermission", () => {
  test("resolves with {ok: false, accepted: false, error: ...} when LOCATION not declared", async () => {
    const {session} = await connectedSession({location: false})
    const result = await session.navigation.requestPermission()
    expect(result.ok).toBe(false)
    expect(result.accepted).toBe(false)
    expect(result.error).toMatch(/LOCATION permission not declared/)
  })

  test("emits NAVIGATION_REQUEST_PERMISSION with a requestId", async () => {
    const {session, transport} = await connectedSession({location: true})
    void session.navigation.requestPermission()

    const env = lastEnvelope(transport)
    expect(env.payload.type).toBe(emitRequest.type)
    expect(env.requestId).toBeDefined()
  })

  test("resolves with the Android-side {ok, accepted} ack", async () => {
    const {session, transport} = await connectedSession({location: true})
    const promise = session.navigation.requestPermission()
    ackLatest(transport, androidAccepted)
    await expect(promise).resolves.toEqual(androidAccepted)
  })

  test("forwards iOS-style {ok: false, accepted: false} verbatim", async () => {
    const {session, transport} = await connectedSession({location: true})
    const promise = session.navigation.requestPermission()
    ackLatest(transport, iosNotSupported)
    await expect(promise).resolves.toEqual(iosNotSupported)
  })
})
