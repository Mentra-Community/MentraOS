/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {connectedSession} from "../helpers"

import granted from "./fixtures/granted.expected.json"
import denied from "./fixtures/denied.expected.json"

describe("navigation.hasPermission", () => {
  test("returns true when LOCATION is in the manifest", async () => {
    const {session} = await connectedSession({location: true})
    expect(session.navigation.hasPermission).toBe(granted.hasPermission)
  })

  test("returns false when LOCATION is absent", async () => {
    const {session} = await connectedSession({location: false})
    expect(session.navigation.hasPermission).toBe(denied.hasPermission)
  })
})
