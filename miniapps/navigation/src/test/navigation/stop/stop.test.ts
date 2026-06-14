/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {connectedSession, lastEnvelope} from "../helpers"

import oneShot from "./fixtures/one-shot.expected.json"

describe("navigation.stop", () => {
  test("sends NAVIGATION_STOP one-shot (no requestId)", async () => {
    const {session, transport} = await connectedSession({location: true})
    const before = transport.sent.length
    session.navigation.stop()

    expect(transport.sent.length).toBe(before + 1)
    const env = lastEnvelope(transport)
    expect(env.payload).toEqual(oneShot)
    expect(env.requestId).toBeUndefined()
  })
})
