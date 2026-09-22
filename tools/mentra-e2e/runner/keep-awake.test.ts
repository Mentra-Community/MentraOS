import {expect, test} from "bun:test"
import {keepAwake} from "./keep-awake"

const nativeTest = process.env.MENTRA_E2E_NATIVE_CHECKS === "1" ? test : test.skip

nativeTest("holds display and idle-sleep assertions only until released", async () => {
  const awake = keepAwake()
  try {
    const deadline = Date.now() + 2000
    let owned: string[] = []
    while (Date.now() < deadline) {
      const assertions = Bun.spawnSync(["/usr/bin/pmset", "-g", "assertions"]).stdout.toString()
      owned = assertions.split("\n").filter((line) => line.includes(`pid ${awake.pid}(caffeinate)`))
      if (owned.length >= 3) break
      await Bun.sleep(50)
    }
    expect(owned.some((line) => line.includes("PreventUserIdleSystemSleep"))).toBe(true)
    expect(owned.some((line) => line.includes("PreventUserIdleDisplaySleep"))).toBe(true)
    expect(owned.some((line) => line.includes("UserIsActive"))).toBe(true)
  } finally {
    await awake.stop()
  }
  const after = Bun.spawnSync(["/usr/bin/pmset", "-g", "assertions"]).stdout.toString()
  expect(after).not.toContain(`pid ${awake.pid}(caffeinate)`)
})
