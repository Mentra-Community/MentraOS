/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {MiniappRequestType} from "../protocol"
import type {MiniappSession} from "../session"
import {LedModule, type LedControlResult} from "./led"

function mockSession(result: LedControlResult) {
  const requestCalls: object[] = []
  const session = {
    sendOneShot: () => {
      throw new Error("LED controls should use sendRequest")
    },
    sendRequest: (payload: object) => {
      requestCalls.push(payload)
      return Promise.resolve(result)
    },
  } as unknown as MiniappSession

  return {session, requestCalls}
}

describe("LedModule", () => {
  test("turnOn resolves from a Bluetooth RGB LED response", async () => {
    const result: LedControlResult = {
      type: "rgb_led_control_response",
      state: "success",
      requestId: "led-1",
    }
    const {session, requestCalls} = mockSession(result)
    const led = new LedModule(session)

    await expect(led.turnOn({color: "blue", ontime: 250, offtime: 100, count: 3})).resolves.toEqual(result)
    expect(requestCalls).toEqual([
      {
        type: MiniappRequestType.RGB_LED,
        action: "on",
        color: "blue",
        ontime: 250,
        offtime: 100,
        count: 3,
      },
    ])
  })

  test("turnOff resolves from a Bluetooth RGB LED response", async () => {
    const result: LedControlResult = {
      type: "rgb_led_control_response",
      state: "success",
      requestId: "led-2",
    }
    const {session, requestCalls} = mockSession(result)
    const led = new LedModule(session)

    await expect(led.turnOff()).resolves.toEqual(result)
    expect(requestCalls).toEqual([
      {
        type: MiniappRequestType.RGB_LED,
        action: "off",
      },
    ])
  })
})
