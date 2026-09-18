import {IosCallVisibility} from "./IosCallVisibility"

function fixture(initialEnabled = false, previouslyEnabled = false) {
  let enabled = initialEnabled
  let savedEnabled = previouslyEnabled
  let hidden = false
  let running = true
  const events: string[] = []
  const install = jest.fn(async () => {
    events.push("install")
  })
  const stop = jest.fn(async () => {
    events.push("stop")
  })
  const controller = new IosCallVisibility({
    isEnabled: () => enabled,
    wasEnabled: () => savedEnabled,
    saveEnabled: (value) => {
      savedEnabled = value
    },
    setHidden: (value) => {
      hidden = value
      events.push(`hidden:${value}`)
    },
    clearRunningState: () => {
      running = false
    },
    install,
    stop,
  })
  return {
    controller,
    install,
    stop,
    events,
    setEnabled: (value: boolean) => {
      enabled = value
    },
    manuallyHide: () => {
      hidden = true
    },
    state: () => ({hidden, running, savedEnabled}),
  }
}

describe("iOS Call visibility lifecycle", () => {
  it("hides a cached visible/running entry synchronously before startup restoration", async () => {
    const f = fixture(false, true) // Earlier PR build already ran migration 5.
    const pending = f.controller.reconcile()
    expect(f.state()).toEqual({hidden: true, running: false, savedEnabled: false})
    await pending
    expect(f.stop).toHaveBeenCalledTimes(1)
    expect(f.install).not.toHaveBeenCalled()
  })

  it("installs and unhides on explicit opt-in, then preserves ordinary home hiding", async () => {
    const f = fixture()
    await f.controller.reconcile()
    f.setEnabled(true)
    await f.controller.reconcile()
    expect(f.state().hidden).toBe(false)
    expect(f.events.indexOf("install")).toBeLessThan(f.events.indexOf("hidden:false"))
    f.manuallyHide()
    await f.controller.reconcile()
    expect(f.state().hidden).toBe(true)
    expect(f.state().savedEnabled).toBe(true)
  })

  it("does not unhide after an installation finishes under a now-disabled policy", async () => {
    const f = fixture(true)
    let complete!: () => void
    f.install.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        }),
    )
    const first = f.controller.reconcile()
    await Promise.resolve()
    await Promise.resolve()
    f.setEnabled(false)
    const second = f.controller.reconcile()
    expect(f.state().hidden).toBe(true)
    complete()
    await Promise.all([first, second])
    expect(f.events).not.toContain("hidden:false")
    expect(f.state().savedEnabled).toBe(false)
  })

  it("honors a quick off/on transition while installation is in flight", async () => {
    const f = fixture(true, true)
    let complete!: () => void
    f.install.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        }),
    )
    const first = f.controller.reconcile()
    await Promise.resolve()
    await Promise.resolve()
    f.setEnabled(false)
    const second = f.controller.reconcile()
    f.setEnabled(true)
    const third = f.controller.reconcile()
    complete()
    await Promise.all([first, second, third])
    expect(f.state().hidden).toBe(false)
    expect(f.state().savedEnabled).toBe(true)
  })

  it("reports install failure without marking enablement successful and permits retry", async () => {
    const f = fixture()
    await f.controller.reconcile()
    f.setEnabled(true)
    f.install.mockRejectedValueOnce(new Error("install failed"))
    await expect(f.controller.reconcile()).rejects.toThrow("install failed")
    expect(f.state().hidden).toBe(true)
    expect(f.state().savedEnabled).toBe(false)
    await f.controller.reconcile()
    expect(f.state().hidden).toBe(false)
  })

  it("does not publish stale enablement after disposal during installation", async () => {
    const f = fixture(true)
    let complete!: () => void
    f.install.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        }),
    )
    const pending = f.controller.reconcile()
    await Promise.resolve()
    await Promise.resolve()
    f.controller.dispose()
    complete()
    await pending
    expect(f.events).not.toContain("hidden:false")
    expect(f.state().savedEnabled).toBe(false)
  })
})
