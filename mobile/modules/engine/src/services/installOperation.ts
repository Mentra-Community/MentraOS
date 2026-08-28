let lastInstallOperationId = 0
let installFilesystemTail: Promise<void> = Promise.resolve()

export type ActivationArtifact = {
  kind: "backup" | "committed" | "pending" | "staging"
  version: string
  timestamp: number
  hadExisting?: boolean
}

export function parseActivationArtifact(name: string): ActivationArtifact | null {
  const pendingMatch = /^\.(committed|pending)-(existing|new)-(.+)-(\d{10,})$/.exec(name)
  if (pendingMatch) {
    const timestamp = Number(pendingMatch[4])
    if (!Number.isSafeInteger(timestamp)) return null
    return {
      kind: pendingMatch[1] as "committed" | "pending",
      hadExisting: pendingMatch[2] === "existing",
      version: pendingMatch[3],
      timestamp,
    }
  }

  const match = /^\.(backup|staging)-(.+)-(\d{10,})$/.exec(name)
  if (!match) return null
  const timestamp = Number(match[3])
  if (!Number.isSafeInteger(timestamp)) return null
  return {kind: match[1] as ActivationArtifact["kind"], version: match[2], timestamp}
}

export type InterruptedActivationRecovery = "keep-target" | "remove-target" | "restore-backup"

export function interruptedActivationRecovery(input: {
  hasBackup: boolean
  hadExisting: boolean
}): InterruptedActivationRecovery {
  if (input.hasBackup) return "restore-backup"
  return input.hadExisting ? "keep-target" : "remove-target"
}

/**
 * Return a process-unique, timestamp-shaped id for install transaction paths.
 *
 * AppRegistry recovery records historically end in a numeric timestamp, so
 * keeping this shape preserves crash recovery while the monotonic increment
 * prevents concurrent installs in the same millisecond from sharing paths.
 */
export function nextInstallOperationId(now = Date.now()): string {
  lastInstallOperationId = Math.max(Math.trunc(now), lastInstallOperationId + 1)
  return String(lastInstallOperationId)
}

/** Match only host-owned extraction directories, including the legacy name. */
export function isInstallScratchDirectoryName(name: string): boolean {
  return /^lma_unzip(?:-\d{10,})?$/.test(name)
}

/**
 * Serialize extraction and activation across every AppRegistry install path.
 * Downloads and archive validation happen before this transaction, but the
 * shared on-device package tree must only be mutated by one install at a time.
 */
export function runInstallFilesystemTransaction<T>(run: () => Promise<T>): Promise<T> {
  const result = installFilesystemTail.then(run, run)
  installFilesystemTail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export interface ActivatedInstall<T> {
  value: T
  commit(): void | Promise<void>
  rollback(options?: {preserveRecoveryState?: boolean}): void | Promise<void>
  recordRecoveryState(serializedState: string): void
}

export interface InstallFinalization {
  apply(): void | Promise<void>
  rollback(): void | Promise<void>
  afterCommit?(): void | Promise<void>
}

/**
 * Keep filesystem activation and durable metadata finalization in one queue.
 * A finalization failure restores the previous bundle (or removes a first
 * install) before another install may inspect or mutate the package tree.
 */
export function completeInstallFilesystemTransaction<T>(
  activate: () => Promise<ActivatedInstall<T>>,
  finalize: (value: T, activation: ActivatedInstall<T>) => InstallFinalization | Promise<InstallFinalization>,
): Promise<T> {
  return runInstallFilesystemTransaction(async () => {
    const activation = await activate()
    let finalization: InstallFinalization
    try {
      finalization = await finalize(activation.value, activation)
    } catch (error) {
      await activation.rollback()
      throw error
    }
    try {
      await finalization.apply()
    } catch (error) {
      await rollbackInstall(error, activation, finalization)
    }
    try {
      await activation.commit()
    } catch (error) {
      await rollbackInstall(error, activation, finalization)
    }
    await finalization.afterCommit?.()
    return activation.value
  })
}

async function rollbackInstall<T>(
  cause: unknown,
  activation: ActivatedInstall<T>,
  finalization: InstallFinalization,
): Promise<never> {
  let metadataRollbackError: unknown
  try {
    await finalization.rollback()
  } catch (error) {
    metadataRollbackError = error
  }

  try {
    await activation.rollback({preserveRecoveryState: metadataRollbackError !== undefined})
  } catch (filesystemRollbackError) {
    throw new AggregateError(
      [cause, ...(metadataRollbackError === undefined ? [] : [metadataRollbackError]), filesystemRollbackError],
      "install rollback failed; startup recovery will retry",
    )
  }

  if (metadataRollbackError !== undefined) {
    throw new AggregateError(
      [cause, metadataRollbackError],
      "install metadata rollback failed; startup recovery will retry",
    )
  }
  throw cause
}
