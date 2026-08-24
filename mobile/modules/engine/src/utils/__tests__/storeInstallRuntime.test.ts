import {describe, expect, test} from "bun:test"

import {installWithRuntimeReload, type StoreInstallRuntimeLauncher} from "../storeInstallRuntime"

function launcher(running: boolean) {
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
      isRunning = true
    },
  }
  return {calls, value}
}

describe("installWithRuntimeReload", () => {
  test("leaves a stopped target stopped", async () => {
    const runtime = launcher(false)
    await expect(
      installWithRuntimeReload(runtime.value, "com.example.app", async () => {
        runtime.calls.push("install")
        return "installed"
      }),
    ).resolves.toBe("installed")
    expect(runtime.calls).toEqual(["install"])
  })

  test("replaces a running context around activation", async () => {
    const runtime = launcher(true)
    await installWithRuntimeReload(runtime.value, "com.example.app", async () => {
      runtime.calls.push("install")
    })
    expect(runtime.calls).toEqual(["stop", "install", "start"])
  })

  test("restores the active version when installation fails", async () => {
    const runtime = launcher(true)
    await expect(
      installWithRuntimeReload(runtime.value, "com.example.app", async () => {
        runtime.calls.push("install")
        throw new Error("download failed")
      }),
    ).rejects.toThrow("download failed")
    expect(runtime.calls).toEqual(["stop", "install", "start"])
  })
})
