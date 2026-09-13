import {describe, expect, test} from "bun:test"

import {installWithRuntimeReload, type StoreInstallRuntimeLauncher} from "../storeInstallRuntime"

function launcher(running: boolean, startFailures = 0) {
  const calls: string[] = []
  let isRunning = running
  const value: StoreInstallRuntimeLauncher = {
    isRunning: () => isRunning,
    stop: async () => {
      calls.push("stop")
      isRunning = false
    },
    ensureRunning: async () => {
      calls.push("start")
      if (startFailures > 0) {
        startFailures -= 1
        throw new Error("launch failed")
      }
      isRunning = true
    },
  }
  return {calls, value}
}

describe("installWithRuntimeReload", () => {
  test("leaves a stopped target stopped", async () => {
    const runtime = launcher(false)
    await expect(
      installWithRuntimeReload(
        runtime.value,
        "com.example.app",
        async () => {
          runtime.calls.push("install")
          return "installed"
        },
        {restorePreviousVersion: () => runtime.calls.push("restore")},
      ),
    ).resolves.toBe("installed")
    expect(runtime.calls).toEqual(["install"])
  })

  test("replaces a running context around activation", async () => {
    const runtime = launcher(true)
    await installWithRuntimeReload(
      runtime.value,
      "com.example.app",
      async () => {
        runtime.calls.push("install")
      },
      {restorePreviousVersion: () => runtime.calls.push("restore")},
    )
    expect(runtime.calls).toEqual(["stop", "install", "start"])
  })

  test("restores the active version when installation fails", async () => {
    const runtime = launcher(true)
    await expect(
      installWithRuntimeReload(
        runtime.value,
        "com.example.app",
        async () => {
          runtime.calls.push("install")
          throw new Error("download failed")
        },
        {restorePreviousVersion: () => runtime.calls.push("restore")},
      ),
    ).rejects.toThrow("download failed")
    expect(runtime.calls).toEqual(["stop", "install", "start"])
  })

  test("reports success when a transient post-install launch succeeds on retry", async () => {
    const runtime = launcher(true, 1)
    await expect(
      installWithRuntimeReload(
        runtime.value,
        "com.example.app",
        async () => {
          runtime.calls.push("install")
          return "installed"
        },
        {restorePreviousVersion: () => runtime.calls.push("restore")},
      ),
    ).resolves.toBe("installed")
    expect(runtime.calls).toEqual(["stop", "install", "start", "start"])
  })

  test("reports success when launch throws after registering the new context", async () => {
    const runtime = launcher(true)
    runtime.value.ensureRunning = async () => {
      runtime.calls.push("start")
      runtime.value.isRunning = () => true
      throw new Error("late launch signal")
    }
    await expect(
      installWithRuntimeReload(
        runtime.value,
        "com.example.app",
        async () => {
          runtime.calls.push("install")
          return "installed"
        },
        {restorePreviousVersion: () => runtime.calls.push("restore")},
      ),
    ).resolves.toBe("installed")
    expect(runtime.calls).toEqual(["stop", "install", "start"])
  })

  test("restores the prior version when the new version cannot launch", async () => {
    const runtime = launcher(true, 2)
    await expect(
      installWithRuntimeReload(
        runtime.value,
        "com.example.app",
        async () => {
          runtime.calls.push("install")
        },
        {restorePreviousVersion: () => runtime.calls.push("restore")},
      ),
    ).rejects.toThrow("launch failed")
    expect(runtime.calls).toEqual(["stop", "install", "start", "start", "restore", "start"])
  })
})
