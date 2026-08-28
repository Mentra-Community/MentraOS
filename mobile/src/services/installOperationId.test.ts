import {
  completeInstallFilesystemTransaction,
  interruptedActivationRecovery,
  isInstallScratchDirectoryName,
  isInstalledVersionDirectoryName,
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

  test("keeps transaction and unknown hidden directories out of installed version discovery", () => {
    expect(isInstalledVersionDirectoryName("2.0.0")).toBe(true)
    expect(isInstalledVersionDirectoryName("dev-1800000000000")).toBe(true)
    expect(isInstalledVersionDirectoryName(".pending-new-2.0.0-1800000000000")).toBe(false)
    expect(isInstalledVersionDirectoryName(".unknown-recovery-artifact")).toBe(false)
  })

  test("recognizes pending activation journals for crash rollback", () => {
    expect(parseActivationArtifact(".pending-existing-2.0.0-beta.1-1800000000000")).toEqual({
      kind: "pending",
      hadExisting: true,
      version: "2.0.0-beta.1",
      timestamp: 1_800_000_000_000,
    })
    expect(parseActivationArtifact(".committed-new-2.0.0-1800000000001")).toEqual({
      kind: "committed",
      hadExisting: false,
      version: "2.0.0",
      timestamp: 1_800_000_000_001,
    })
    expect(parseActivationArtifact("2.0.0")).toBeNull()
  })

  test("keeps a restored prior target when recovery itself was interrupted", () => {
    expect(interruptedActivationRecovery({hasBackup: true, hadExisting: true})).toBe("restore-backup")
    expect(interruptedActivationRecovery({hasBackup: false, hadExisting: true})).toBe("keep-target")
    expect(interruptedActivationRecovery({hasBackup: false, hadExisting: false})).toBe("remove-target")
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
          recordRecoveryState: () => undefined,
        }),
        () => ({
          apply: () => {
            events.push("metadata:apply")
            throw new Error("MMKV write failed")
          },
          rollback: () => {
            events.push("metadata:rollback")
          },
        }),
      ),
    ).rejects.toThrow("MMKV write failed")

    expect(events).toEqual(["metadata:apply", "metadata:rollback", "rollback"])
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
        recordRecoveryState: () => undefined,
      }),
      () => {
        events.push("finalize")
        return {
          apply: () => {
            events.push("metadata:apply")
          },
          rollback: () => {
            events.push("metadata:rollback")
          },
          afterCommit: () => {
            events.push("afterCommit")
          },
        }
      },
    )

    expect(events).toEqual(["finalize", "metadata:apply", "commit", "afterCommit"])
  })

  test("restores metadata and filesystem when the atomic commit marker fails", async () => {
    const events: string[] = []

    await expect(
      completeInstallFilesystemTransaction(
        async () => ({
          value: {packageName: "com.example.app", version: "2.0.0"},
          commit: () => {
            events.push("commit")
            throw new Error("journal rename failed")
          },
          rollback: () => {
            events.push("filesystem:rollback")
          },
          recordRecoveryState: () => undefined,
        }),
        () => ({
          apply: () => {
            events.push("metadata:apply")
          },
          rollback: () => {
            events.push("metadata:rollback")
          },
        }),
      ),
    ).rejects.toThrow("journal rename failed")

    expect(events).toEqual(["metadata:apply", "commit", "metadata:rollback", "filesystem:rollback"])
  })

  test("preserves the durable journal when metadata rollback must retry on startup", async () => {
    const events: string[] = []

    await expect(
      completeInstallFilesystemTransaction(
        async () => ({
          value: {packageName: "com.example.app", version: "2.0.0"},
          commit: () => undefined,
          rollback: (options?: {preserveRecoveryState?: boolean}) => {
            events.push(`filesystem:rollback:${options?.preserveRecoveryState === true}`)
          },
          recordRecoveryState: () => undefined,
        }),
        () => ({
          apply: () => {
            throw new Error("MMKV write failed")
          },
          rollback: () => {
            events.push("metadata:rollback")
            throw new Error("MMKV rollback failed")
          },
        }),
      ),
    ).rejects.toThrow("startup recovery will retry")

    expect(events).toEqual(["metadata:rollback", "filesystem:rollback:true"])
  })
})
