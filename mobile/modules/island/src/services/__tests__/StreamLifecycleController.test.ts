/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

import {StreamLifecycleController, type LifecycleLogger} from "../StreamLifecycleController"

const noopLogger: LifecycleLogger = {
  child: () => noopLogger,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

function makeController(overrides: Partial<{
  keepAliveIntervalMs: number
  ackTimeoutMs: number
  maxMissedAcks: number
}> = {}) {
  const sendKeepAlive = mock<(ackId: string) => Promise<void>>(async () => {})
  const onTimeout = mock<() => void>(() => {})

  const controller = new StreamLifecycleController(
    {
      logger: noopLogger,
      streamId: "test-stream",
      keepAliveIntervalMs: overrides.keepAliveIntervalMs ?? 15_000,
      ackTimeoutMs: overrides.ackTimeoutMs ?? 10_000,
      maxMissedAcks: overrides.maxMissedAcks ?? 3,
    },
    {sendKeepAlive, onTimeout},
  )
  return {controller, sendKeepAlive, onTimeout}
}

describe("StreamLifecycleController (phone copy)", () => {
  beforeEach(() => {
    // bun:test fake timers are opt-in per test where needed.
  })

  test("setActive(true) starts emitting keep-alives at the configured interval", async () => {
    const {controller, sendKeepAlive} = makeController({
      keepAliveIntervalMs: 50,
      ackTimeoutMs: 1000,
    })
    controller.setActive(true)
    await new Promise((r) => setTimeout(r, 175))
    controller.dispose()
    // Three ticks at 50ms over 175ms.
    expect(sendKeepAlive.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  test("handleAck clears the pending timeout and resets missedAcks", async () => {
    const {controller, sendKeepAlive, onTimeout} = makeController({
      keepAliveIntervalMs: 30,
      ackTimeoutMs: 60,
      maxMissedAcks: 2,
    })
    let capturedAckId: string | undefined
    sendKeepAlive.mockImplementation(async (ackId) => {
      capturedAckId = ackId
    })
    controller.setActive(true)
    await new Promise((r) => setTimeout(r, 45))
    expect(capturedAckId).toBeDefined()
    controller.handleAck(capturedAckId!)
    // Wait past the would-be ack timeout — should NOT escalate.
    await new Promise((r) => setTimeout(r, 80))
    controller.dispose()
    expect(onTimeout).not.toHaveBeenCalled()
  })

  test("fires onTimeout after maxMissedAcks consecutive missed acks", async () => {
    const {controller, onTimeout} = makeController({
      keepAliveIntervalMs: 20,
      ackTimeoutMs: 20,
      maxMissedAcks: 2,
    })
    controller.setActive(true)
    // Two ticks at 20ms with 20ms ack timeout each ≈ 80ms total. Wait longer.
    await new Promise((r) => setTimeout(r, 150))
    controller.dispose()
    expect(onTimeout).toHaveBeenCalled()
  })

  test("setActive(false) stops the timer and clears pending acks", async () => {
    const {controller, sendKeepAlive} = makeController({
      keepAliveIntervalMs: 30,
      ackTimeoutMs: 1000,
    })
    controller.setActive(true)
    await new Promise((r) => setTimeout(r, 45))
    const callsAtPause = sendKeepAlive.mock.calls.length
    controller.setActive(false)
    await new Promise((r) => setTimeout(r, 100))
    expect(sendKeepAlive.mock.calls.length).toBe(callsAtPause)
    controller.dispose()
  })

  test("dispose is idempotent and stops further ticks", async () => {
    const {controller, sendKeepAlive} = makeController({keepAliveIntervalMs: 20})
    controller.setActive(true)
    await new Promise((r) => setTimeout(r, 25))
    const callsBeforeDispose = sendKeepAlive.mock.calls.length
    controller.dispose()
    controller.dispose() // second call must not throw
    await new Promise((r) => setTimeout(r, 60))
    expect(sendKeepAlive.mock.calls.length).toBe(callsBeforeDispose)
  })

  test("shouldSendKeepAlive=false skips the send but keeps the timer", async () => {
    const sendKeepAlive = mock(async (_id: string) => {})
    const onTimeout = mock(() => {})
    const controller = new StreamLifecycleController(
      {
        logger: noopLogger,
        streamId: "test",
        keepAliveIntervalMs: 25,
        ackTimeoutMs: 500,
        maxMissedAcks: 5,
        shouldSendKeepAlive: () => false,
      },
      {sendKeepAlive, onTimeout},
    )
    controller.setActive(true)
    await new Promise((r) => setTimeout(r, 80))
    controller.dispose()
    expect(sendKeepAlive).not.toHaveBeenCalled()
  })
})
