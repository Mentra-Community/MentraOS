/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {MiniappRequestType} from "../protocol"
import type {MiniappSession} from "../session"
import {MicModule} from "./mic"

function mockSession() {
  const requestCalls: object[] = []
  const session = {
    sendRequest: (payload: object) => {
      requestCalls.push(payload)
      return Promise.resolve(undefined)
    },
    _subscribe: () => () => {},
    _hasManifestPermission: () => true,
  } as unknown as MiniappSession

  return {session, requestCalls}
}

describe("MicModule", () => {
  test("setVoiceActivityDetectionEnabled sends MIC_SET_VAD_ENABLED", async () => {
    const {session, requestCalls} = mockSession()
    const mic = new MicModule(session)

    await expect(mic.setVoiceActivityDetectionEnabled(false)).resolves.toBeUndefined()
    expect(requestCalls).toEqual([
      {
        type: MiniappRequestType.MIC_SET_VAD_ENABLED,
        enabled: false,
      },
    ])
  })

  test("setLoudnessGateEnabled sends MIC_SET_LOUDNESS_GATE_ENABLED", async () => {
    const {session, requestCalls} = mockSession()
    const mic = new MicModule(session)

    await expect(mic.setLoudnessGateEnabled(true)).resolves.toBeUndefined()
    expect(requestCalls).toEqual([
      {
        type: MiniappRequestType.MIC_SET_LOUDNESS_GATE_ENABLED,
        enabled: true,
      },
    ])
  })
})
