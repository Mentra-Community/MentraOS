import {
  nextInstallOperationId,
  runInstallFilesystemTransaction,
} from "../../modules/engine/src/services/installOperation"

describe("AppRegistry install operation ids", () => {
  test("isolates concurrent installs started in the same millisecond", () => {
    const first = nextInstallOperationId(1_800_000_000_000)
    const second = nextInstallOperationId(1_800_000_000_000)

    expect(second).not.toBe(first)
    expect(Number(second)).toBe(Number(first) + 1)
  })

  test("remains monotonic if the device clock moves backwards", () => {
    const first = nextInstallOperationId(1_900_000_000_000)
    const second = nextInstallOperationId(1_800_000_000_000)

    expect(Number(second)).toBe(Number(first) + 1)
  })

  test("serializes filesystem mutations without poisoning the queue", async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = runInstallFilesystemTransaction(async () => {
      events.push("first:start")
      await firstGate
      events.push("first:end")
      throw new Error("first failed")
    })
    const second = runInstallFilesystemTransaction(async () => {
      events.push("second:start")
      events.push("second:end")
    })

    await Promise.resolve()
    expect(events).toEqual(["first:start"])
    releaseFirst()
    await expect(first).rejects.toThrow("first failed")
    await second
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"])
  })
})
