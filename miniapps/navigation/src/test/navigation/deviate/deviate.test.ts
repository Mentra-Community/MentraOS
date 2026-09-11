/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {connectedSession, lastEnvelope} from "../helpers"

import defaultOffset from "./fixtures/default-offset.expected.json"
import customOffset from "./fixtures/custom-offset.expected.json"

describe("navigation.dev.deviate", () => {
  test("defaults offsetMeters to 20", async () => {
    const {session, transport} = await connectedSession({location: true})
    session.navigation.dev.deviate()
    expect(lastEnvelope(transport).payload).toEqual(defaultOffset)
  })

  test("forwards custom offset and is a one-shot (no requestId)", async () => {
    const {session, transport} = await connectedSession({location: true})
    session.navigation.dev.deviate(75)
    const env = lastEnvelope(transport)
    expect(env.payload).toEqual(customOffset)
    expect(env.requestId).toBeUndefined()
  })
})
