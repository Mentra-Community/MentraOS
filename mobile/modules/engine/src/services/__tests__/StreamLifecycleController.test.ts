/// <reference types="bun-types" />

import {describe, expect, mock, test} from "bun:test"

import {StreamLifecycleController, type LifecycleLogger} from "../StreamLifecycleController"

const noopLogger: LifecycleLogger = {
  child: () => noopLogger,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const jsTimers = {
  setInterval: (callback: () => void, delay: number) => setInterval(callback, delay) as unknown as number,
  clearInterval: (intervalId: number) => clearInterval(intervalId),
  setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay) as unknown as number,
  clearTimeout: (timeoutId: number) => clearTimeout(timeoutId),
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
      timers: jsTimers,
    },
    {sendKeepAlive, onTimeout},
  )
  return {controller, sendKeepAlive, onTimeout}
}

describe("StreamLifecycleController (phone copy)", () => {
  test("keep-alive interval and ack timeout go through the injected timer API", () => {
    const setInterval = mock((callback: () => void, delay: number) => {
      void callback
      void delay
      return 11
    })
    const setTimeout = mock((callback: () => void, delay: number) => {
      void callback
      void delay
      return 22
    })
    const clearInterval = mock((_id: number) => {})
    const clearTimeout = mock((_id: number) => {})
    const controller = new StreamLifecycleController(
      {
        logger: noopLogger,
        streamId: "injected",
        keepAliveIntervalMs: 15_000,
        ackTimeoutMs: 10_000,
        maxMissedAcks: 3,
        timers: {setInterval, clearInterval, setTimeout, clearTimeout},
      },
      {sendKeepAlive: async () => {}, onTimeout: () => {}},
    )
    controller.setActive(true)
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 15_000)
    const tick = setInterval.mock.calls[0]![0] as () => void
    tick()
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 10_000)
    controller.dispose()
    expect(clearInterval).toHaveBeenCalledWith(11)
    expect(clearTimeout).toHaveBeenCalledWith(22)
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

  test("tickNow sends a keep-alive immediately while active", async () => {
    const {controller, sendKeepAlive} = makeController({keepAliveIntervalMs: 10_000, ackTimeoutMs: 1000})
    controller.setActive(true)
    expect(sendKeepAlive).not.toHaveBeenCalled()
    controller.tickNow()
    await Promise.resolve()
    expect(sendKeepAlive).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  test("tickNow is a no-op while paused or disposed", async () => {
    const {controller, sendKeepAlive} = makeController({keepAliveIntervalMs: 10_000, ackTimeoutMs: 1000})
    controller.tickNow()
    controller.setActive(true)
    controller.setActive(false)
    controller.tickNow()
    controller.dispose()
    controller.tickNow()
    await Promise.resolve()
    expect(sendKeepAlive).not.toHaveBeenCalled()
  })

  test("pause then resume: pending acks from before the pause never escalate", async () => {
    const {controller, sendKeepAlive, onTimeout} = makeController({
      keepAliveIntervalMs: 10_000,
      ackTimeoutMs: 30,
      maxMissedAcks: 1,
    })
    controller.setActive(true)
    controller.tickNow()
    await Promise.resolve()
    expect(sendKeepAlive).toHaveBeenCalledTimes(1)
    // Link drops: pause clears the outstanding ack timer.
    controller.setActive(false)
    await new Promise((r) => setTimeout(r, 60))
    expect(onTimeout).not.toHaveBeenCalled()
    // Link returns: resume + immediate heartbeat.
    controller.setActive(true)
    controller.tickNow()
    await Promise.resolve()
    expect(sendKeepAlive).toHaveBeenCalledTimes(2)
    controller.dispose()
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
        timers: jsTimers,
      },
      {sendKeepAlive, onTimeout},
    )
    controller.setActive(true)
    await new Promise((r) => setTimeout(r, 80))
    controller.dispose()
    expect(sendKeepAlive).not.toHaveBeenCalled()
  })
})
