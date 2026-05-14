import {miniappRunningRegistry} from "../MiniappRunningRegistry"

describe("MiniappRunningRegistry", () => {
  beforeEach(() => {
    miniappRunningRegistry._resetForTests()
  })

  test("add then has + getAll returns the package", () => {
    miniappRunningRegistry.add("com.foo")
    expect(miniappRunningRegistry.has("com.foo")).toBe(true)
    expect(miniappRunningRegistry.getAll()).toEqual(["com.foo"])
  })

  test("add is idempotent — second add is a no-op (no extra notify)", () => {
    const listener = jest.fn()
    miniappRunningRegistry.subscribe(listener)
    miniappRunningRegistry.add("com.foo")
    miniappRunningRegistry.add("com.foo")
    expect(listener).toHaveBeenCalledTimes(1)
  })

  test("remove clears membership and notifies", () => {
    const listener = jest.fn()
    miniappRunningRegistry.add("com.foo")
    miniappRunningRegistry.subscribe(listener)
    miniappRunningRegistry.remove("com.foo")
    expect(miniappRunningRegistry.has("com.foo")).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  test("remove of unknown package does not notify", () => {
    const listener = jest.fn()
    miniappRunningRegistry.subscribe(listener)
    miniappRunningRegistry.remove("com.unknown")
    expect(listener).not.toHaveBeenCalled()
  })

  test("new add initialises lastForegroundAt to 0", () => {
    miniappRunningRegistry.add("com.foo")
    expect(miniappRunningRegistry.getLastForegroundAt("com.foo")).toBe(0)
  })

  test("markForeground stamps the current time", () => {
    miniappRunningRegistry.add("com.foo")
    miniappRunningRegistry.markForeground("com.foo", 12345)
    expect(miniappRunningRegistry.getLastForegroundAt("com.foo")).toBe(12345)
  })

  test("markForeground without explicit timestamp uses Date.now()", () => {
    miniappRunningRegistry.add("com.foo")
    const before = Date.now()
    miniappRunningRegistry.markForeground("com.foo")
    const after = Date.now()
    const stamped = miniappRunningRegistry.getLastForegroundAt("com.foo")
    expect(stamped).toBeGreaterThanOrEqual(before)
    expect(stamped).toBeLessThanOrEqual(after)
  })

  test("markForeground on unknown package is a silent no-op", () => {
    const listener = jest.fn()
    miniappRunningRegistry.subscribe(listener)
    miniappRunningRegistry.markForeground("com.unknown")
    expect(listener).not.toHaveBeenCalled()
  })

  test("getLastForegroundAt of unknown package returns 0", () => {
    expect(miniappRunningRegistry.getLastForegroundAt("com.absent")).toBe(0)
  })

  test("getAllWithTimestamps returns a copy of every entry", () => {
    miniappRunningRegistry.add("a")
    miniappRunningRegistry.add("b")
    miniappRunningRegistry.markForeground("a", 100)
    const snap = miniappRunningRegistry.getAllWithTimestamps()
    expect(snap).toHaveLength(2)
    expect(snap.find((e) => e.packageName === "a")?.lastForegroundAt).toBe(100)
    expect(snap.find((e) => e.packageName === "b")?.lastForegroundAt).toBe(0)
  })

  test("getAllWithTimestamps returns a deep-cloned snapshot — mutating it does not affect the registry", () => {
    miniappRunningRegistry.add("a")
    const snap = miniappRunningRegistry.getAllWithTimestamps()
    snap[0].lastForegroundAt = 9999
    expect(miniappRunningRegistry.getLastForegroundAt("a")).toBe(0)
  })

  test("subscribe returns an unsubscribe that detaches the listener", () => {
    const listener = jest.fn()
    const off = miniappRunningRegistry.subscribe(listener)
    miniappRunningRegistry.add("a")
    off()
    miniappRunningRegistry.add("b")
    expect(listener).toHaveBeenCalledTimes(1)
  })

  test("subscriber that throws does not bring down notify (warning is logged)", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    miniappRunningRegistry.subscribe(() => {
      throw new Error("boom")
    })
    expect(() => miniappRunningRegistry.add("a")).not.toThrow()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
