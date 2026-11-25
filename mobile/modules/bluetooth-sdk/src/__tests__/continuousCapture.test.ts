import {beforeEach, describe, expect, it, jest} from "@jest/globals"

// The fast link, faked: the test says when it comes up or goes down, and whether opening fails.
const mockLink = {
  opens: 0,
  closes: 0,
  fail: false,
  held: false,
  state: {glasses: "connected" as "connected" | "disconnected", fast: "down" as "up" | "down"},
  listeners: new Set<(state: {glasses: string; fast: string}) => void>(),
}
jest.mock("../glasses-wifi/link", () => ({
  createLink: () => ({
    get state() {
      return {...mockLink.state}
    },
    onChange: (listener: (state: {glasses: string; fast: string}) => void) => {
      mockLink.listeners.add(listener)
      return () => mockLink.listeners.delete(listener)
    },
    openFast: async () => {
      mockLink.opens++
      if (mockLink.fail) throw new Error("no link")
      // Opening a link already held waits for that link to be back, as the service does.
      if (mockLink.held) {
        if (mockLink.state.fast === "up") return
        await new Promise<void>((resolve) => {
          const listener = (state: {fast: string}) => {
            if (state.fast !== "up") return
            mockLink.listeners.delete(listener)
            resolve()
          }
          mockLink.listeners.add(listener)
        })
        return
      }
      mockLink.held = true
      mockLink.state = {...mockLink.state, fast: "up"}
    },
    closeFast: async () => {
      mockLink.closes++
      mockLink.held = false
    },
  }),
}))
jest.mock("../glasses-wifi/native", () => ({delay: () => new Promise<void>((resolve) => setTimeout(resolve, 0))}))
const setFast = (fast: "up" | "down") => {
  mockLink.state = {...mockLink.state, fast}
  mockLink.listeners.forEach((listener) => listener({...mockLink.state}))
}

const {runContinuousCapture} = jest.requireActual<typeof import("../glasses-wifi/continuous")>(
  "../glasses-wifi/continuous",
)
const settle = async () => {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Captures the camera takes at once; each records its options and can be released. */
function camera() {
  const taken: Array<{options: {sound?: boolean}; release: () => void}> = []
  const take = (options: {sound?: boolean}, released: () => void) => {
    const capture = {options, captured: Promise.resolve(), release: released}
    taken.push(capture)
    return capture
  }
  return {taken, take}
}

describe("continuous capture", () => {
  beforeEach(() => {
    Object.assign(mockLink, {opens: 0, closes: 0, fail: false, held: false, state: {glasses: "connected", fast: "down"}})
    mockLink.listeners.clear()
  })

  it("holds the fast link and takes photos back to back, pausing while maxPending wait on the glasses", async () => {
    const {taken, take} = camera()
    const run = runContinuousCapture(take, {sound: false, maxPending: 3}, "test")
    const photos: unknown[] = []
    const states: string[] = []
    run.onPhoto((capture) => photos.push(capture))
    run.onState((state) => states.push(state))
    await settle()
    expect(mockLink.opens).toBe(1)
    expect(taken).toHaveLength(3)
    expect(photos).toHaveLength(3)
    // No room on the glasses: paused, and heard.
    expect(run.state).toBe("paused")
    // Releasing one makes room for the next.
    taken[0].release()
    await settle()
    expect(taken).toHaveLength(4)
    expect(states).toEqual(["capturing", "paused", "capturing", "paused"])
    taken.forEach((capture) => capture.release())
    await run.stop()
    expect(mockLink.closes).toBe(1)
  })

  it("pauses while only Bluetooth is left and goes on when the fast link is back", async () => {
    const {taken, take} = camera()
    const run = runContinuousCapture(take, {sound: false, maxPending: 10}, "test")
    const states: string[] = []
    run.onState((state) => states.push(state))
    await settle()
    setFast("down")
    taken.forEach((capture) => capture.release())
    await settle()
    // Room on the glasses, but only Bluetooth: no photos.
    const whilePaused = taken.length
    await settle()
    expect(taken.length).toBe(whilePaused)
    expect(run.state).toBe("paused")
    setFast("up")
    await settle()
    expect(taken.length).toBeGreaterThan(whilePaused)
    expect(states.slice(0, 3)).toEqual(["capturing", "paused", "capturing"])
    taken.forEach((capture) => capture.release())
    await run.stop()
  })

  it("says it is paused when the fast link can't come up from the start", async () => {
    mockLink.fail = true
    const {take} = camera()
    const run = runContinuousCapture(take, {sound: false}, "test")
    const states: string[] = []
    run.onState((state) => states.push(state))
    await settle()
    expect(states).toEqual(["paused"])
    await run.stop()
  })

  it("takes a photo asked for in its turn, even while paused, with its own options", async () => {
    mockLink.fail = true
    const {taken, take} = camera()
    const run = runContinuousCapture(take, {sound: false}, "test")
    await settle()
    expect(run.state).toBe("paused")
    expect(taken).toHaveLength(0)
    const asked = await run.capture({sound: true})
    expect(asked.options).toEqual({sound: true})
    expect(taken).toHaveLength(1)
    asked.release()
    await run.stop()
  })

  it("stops taking photos at once, and gives the link back once its photos are released", async () => {
    const {taken, take} = camera()
    const run = runContinuousCapture(take, {sound: false, maxPending: 1}, "test")
    await settle()
    let stopped = false
    const stopping = run.stop().then(() => (stopped = true))
    await settle()
    // The photo still on the glasses keeps the link.
    expect(stopped).toBe(false)
    expect(mockLink.closes).toBe(0)
    taken[0].release()
    await stopping
    expect(mockLink.closes).toBe(1)
    expect(taken).toHaveLength(1)
    await expect(run.capture()).rejects.toThrow("stopped")
  })
})
