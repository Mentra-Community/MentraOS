/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {MiniappErrorCode} from "@mentra/miniapp"

import {ackLatest, connectedSession, lastEnvelope} from "../helpers"

import emitRequest from "./fixtures/emit-request.expected.json"
import androidAccepted from "./fixtures/android-accepted.response.json"
import iosNotSupported from "./fixtures/ios-not-supported.response.json"

describe("navigation.requestPermission", () => {
  test("throws PERMISSION_NOT_DECLARED synchronously when LOCATION missing", async () => {
    const {session} = await connectedSession({location: false})
    let caught: unknown
    try {
      session.navigation.requestPermission()
    } catch (e) {
      caught = e
    }
    expect((caught as {code: string}).code).toBe(MiniappErrorCode.PERMISSION_NOT_DECLARED)
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
