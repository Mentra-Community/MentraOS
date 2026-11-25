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

const {openCameraSession, PENDING_GUARD} = jest.requireActual<typeof import("../glasses-wifi/camera-session")>(
  "../glasses-wifi/camera-session",
)
const settle = async () => {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Captures the camera takes at once; each records its options and can be released. */
function camera() {
  const taken: Array<{options: {sound?: boolean; size?: string}; release: () => void}> = []
  const take = (options: {sound?: boolean; size?: string}, released: () => void) => {
    // A real capture takes most of a second; this one takes a timer turn, so a trigger yields between photos.
    const capture = {options, captured: new Promise<void>((resolve) => setTimeout(resolve, 0)), release: released}
    taken.push(capture)
    return capture
  }
  return {taken, take}
}

/** A warm camera that counts its holds and releases. */
function warmth(fail = false) {
  const counts = {holds: 0, releases: 0, fail}
  const warm = async () => {
    counts.holds++
    if (counts.fail) throw new Error("glasses away")
    return {release: async () => void counts.releases++}
  }
  return {counts, warm}
}

describe("camera session", () => {
  beforeEach(() => {
    Object.assign(mockLink, {
      opens: 0,
      closes: 0,
      fail: false,
      held: false,
      state: {glasses: "connected", fast: "down"},
    })
    mockLink.listeners.clear()
  })

  it("holds the fast link and the warm camera from open to close, with no photo asked for", async () => {
    const {taken, take} = camera()
    const {counts, warm} = warmth()
    const session = openCameraSession(take, {sound: false}, "test", warm)
    await settle()
    expect(mockLink.opens).toBe(1)
    expect(mockLink.state.fast).toBe("up")
    expect(counts.holds).toBe(1)
    expect(taken).toHaveLength(0)
    await session.close()
    expect(mockLink.closes).toBe(1)
    expect(counts.releases).toBe(1)
  })

  it("takes a photo asked for with the session's options under its own", async () => {
    const {taken, take} = camera()
    const session = openCameraSession(take, {sound: false, size: "large"}, "test")
    await settle()
    const asked = await session.capture({sound: true})
    expect(asked.options).toEqual({sound: true, size: "large"})
    expect(taken).toHaveLength(1)
    asked.release()
    await session.close()
  })

  it("takes a photo asked for even while only Bluetooth is left", async () => {
    mockLink.fail = true
    const {taken, take} = camera()
    const session = openCameraSession(take, {sound: false}, "test")
    await settle()
    const asked = await session.capture()
    expect(taken).toHaveLength(1)
    asked.release()
    await session.close()
  })

  it("asks again for a camera that could not warm when the glasses come back", async () => {
    const {take} = camera()
    const {counts, warm} = warmth(true)
    const session = openCameraSession(take, {sound: false}, "test", warm)
    await settle()
    expect(counts.holds).toBe(1)
    counts.fail = false
    mockLink.listeners.forEach((listener) => listener({glasses: "connected", fast: "up"}))
    await settle()
    expect(counts.holds).toBe(2)
    await session.close()
    expect(counts.releases).toBe(1)
  })

  it("continuous: photos back to back as fast as the camera takes them, with the trigger's options", async () => {
    const {taken, take} = camera()
    const session = openCameraSession(take, {sound: true, size: "large"}, "test")
    const run = session.continuous({sound: false})
    const photos: unknown[] = []
    run.onPhoto((capture) => {
      photos.push(capture)
      ;(capture as {release: () => void}).release()
    })
    await settle()
    expect(mockLink.opens).toBe(1)
    expect(taken.length).toBeGreaterThan(5)
    expect(photos).toHaveLength(taken.length)
    expect(taken[0].options).toEqual({sound: false, size: "large"})
    run.stop()
    await session.close()
    expect(mockLink.closes).toBe(1)
  })

  it("continuous: the guard holds it while photos would pile up on the glasses", async () => {
    const {taken, take} = camera()
    const session = openCameraSession(take, {sound: false}, "test")
    session.continuous()
    await settle()
    // Nothing released: it stops at the guard.
    expect(taken).toHaveLength(PENDING_GUARD)
    taken[0].release()
    await settle()
    expect(taken).toHaveLength(PENDING_GUARD + 1)
    taken.forEach((capture) => capture.release())
    await session.close()
  })

  it("continuous: waits while only Bluetooth is left and goes on when the fast link is back", async () => {
    const {taken, take} = camera()
    const session = openCameraSession(take, {sound: false}, "test")
    session.continuous().onPhoto((capture) => (capture as {release: () => void}).release())
    await settle()
    setFast("down")
    await settle()
    const whileDown = taken.length
    await settle()
    expect(taken.length).toBe(whileDown)
    setFast("up")
    await settle()
    expect(taken.length).toBeGreaterThan(whileDown)
    await session.close()
  })

  it("continuous: takes nothing while the fast link can't come up, but a tap still goes through", async () => {
    mockLink.fail = true
    const {taken, take} = camera()
    const session = openCameraSession(take, {sound: false}, "test")
    session.continuous()
    await settle()
    expect(taken).toHaveLength(0)
    const asked = await session.capture({sound: true})
    expect(asked.options).toEqual({sound: true})
    asked.release()
    await session.close()
  })

  it("stopping the trigger keeps the session's link; starting another replaces it", async () => {
    const {taken, take} = camera()
    const session = openCameraSession(take, {sound: false}, "test")
    const first = session.continuous()
    await settle()
    first.stop()
    const afterStop = taken.length
    taken.forEach((capture) => capture.release())
    await settle()
    expect(taken).toHaveLength(afterStop)
    expect(mockLink.closes).toBe(0)
    const second = session.continuous({size: "a"})
    const seen: string[] = []
    second.onPhoto(() => seen.push("second"))
    const third = session.continuous({size: "b"})
    third.onPhoto((capture) => {
      seen.push("third")
      ;(capture as {release: () => void}).release()
    })
    await settle()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((who) => who === "third")).toBe(true)
    third.stop()
    taken.forEach((capture) => capture.release())
    await session.close()
  })

  it("closes at once for new photos, and gives the link and camera back once its photos are released", async () => {
    const {taken, take} = camera()
    const {counts, warm} = warmth()
    const session = openCameraSession(take, {sound: false}, "test", warm)
    session.continuous()
    await settle()
    session.continuous().stop()
    const handedOut = taken.length
    let closed = false
    const closing = session.close().then(() => (closed = true))
    await settle()
    // The photo still on the glasses keeps the link.
    expect(closed).toBe(false)
    expect(mockLink.closes).toBe(0)
    expect(counts.releases).toBe(0)
    taken.forEach((capture) => capture.release())
    await closing
    expect(mockLink.closes).toBe(1)
    expect(counts.releases).toBe(1)
    expect(taken).toHaveLength(handedOut)
    await expect(session.capture()).rejects.toThrow("closed")
  })
})
