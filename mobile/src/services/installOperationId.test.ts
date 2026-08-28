import {
  completeInstallFilesystemTransaction,
  isInstallScratchDirectoryName,
  nextInstallOperationId,
  parseActivationArtifact,
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

  test("recognizes only host-owned extraction cache directories", () => {
    expect(isInstallScratchDirectoryName("lma_unzip")).toBe(true)
    expect(isInstallScratchDirectoryName("lma_unzip-1800000000000")).toBe(true)
    expect(isInstallScratchDirectoryName("lma_unzip-unrelated")).toBe(false)
    expect(isInstallScratchDirectoryName("other-1800000000000")).toBe(false)
  })

  test("recognizes pending activation journals for crash rollback", () => {
    expect(parseActivationArtifact(".pending-2.0.0-1800000000000")).toEqual({
      kind: "pending",
      version: "2.0.0",
      timestamp: 1_800_000_000_000,
    })
    expect(parseActivationArtifact("2.0.0")).toBeNull()
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

  test("rolls filesystem activation back when metadata finalization fails", async () => {
    const events: string[] = []

    await expect(
      completeInstallFilesystemTransaction(
        async () => ({
          value: {packageName: "com.example.app", version: "2.0.0"},
          commit: () => {
            events.push("commit")
          },
          rollback: () => {
            events.push("rollback")
          },
        }),
        () => {
          events.push("finalize")
          throw new Error("MMKV write failed")
        },
      ),
    ).rejects.toThrow("MMKV write failed")

    expect(events).toEqual(["finalize", "rollback"])
  })

  test("commits filesystem activation only after metadata finalization", async () => {
    const events: string[] = []

    await completeInstallFilesystemTransaction(
      async () => ({
        value: {packageName: "com.example.app", version: "2.0.0"},
        commit: () => {
          events.push("commit")
        },
        rollback: () => {
          events.push("rollback")
        },
      }),
      () => {
        events.push("finalize")
      },
    )

    expect(events).toEqual(["finalize", "commit"])
  })
})
