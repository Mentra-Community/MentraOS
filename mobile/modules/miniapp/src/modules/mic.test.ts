/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {MiniappRequestType} from "../protocol"
import type {MiniappSession} from "../session"
import {MicModule} from "./mic"

function mockSession(reply?: (payload: {type: string}) => unknown) {
  const requestCalls: object[] = []
  const session = {
    sendRequest: (payload: {type: string}) => {
      requestCalls.push(payload)
      return Promise.resolve(reply?.(payload))
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

  test("acquire asks for a use case, never for a gain", async () => {
    const {session, requestCalls} = mockSession(() => ({sessionId: 7}))
    const mic = new MicModule(session)

    const lease = await mic.acquire({source: "glasses", useCase: "voice_call"})

    expect(lease.sessionId).toBe(7)
    expect(requestCalls).toEqual([
      {
        type: MiniappRequestType.MIC_ACQUIRE,
        source: "glasses",
        useCase: "voice_call",
      },
    ])
  })

  test("release sends MIC_RELEASE once, however often it is called", async () => {
    // Teardown paths overlap — a leave and a terminal state can both land — so a second release
    // must not hand back a session the next call already owns.
    const {session, requestCalls} = mockSession(() => ({sessionId: 3}))
    const mic = new MicModule(session)

    const lease = await mic.acquire({source: "glasses", useCase: "voice_call"})
    await lease.release()
    await lease.release()

    expect(requestCalls.filter((call) => (call as {type: string}).type === MiniappRequestType.MIC_RELEASE)).toEqual([
      {type: MiniappRequestType.MIC_RELEASE, sessionId: 3},
    ])
  })
})
