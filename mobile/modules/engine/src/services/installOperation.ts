let lastInstallOperationId = 0
let installFilesystemTail: Promise<void> = Promise.resolve()

export type ActivationArtifact = {kind: "backup" | "pending" | "staging"; version: string; timestamp: number}

export function parseActivationArtifact(name: string): ActivationArtifact | null {
  const match = /^\.(backup|pending|staging)-(.+)-(\d{10,})$/.exec(name)
  if (!match) return null
  const timestamp = Number(match[3])
  if (!Number.isSafeInteger(timestamp)) return null
  return {kind: match[1] as ActivationArtifact["kind"], version: match[2], timestamp}
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
  rollback(): void | Promise<void>
}

/**
 * Keep filesystem activation and durable metadata finalization in one queue.
 * A finalization failure restores the previous bundle (or removes a first
 * install) before another install may inspect or mutate the package tree.
 */
export function completeInstallFilesystemTransaction<T>(
  activate: () => Promise<ActivatedInstall<T>>,
  finalize: (value: T) => void | Promise<void>,
): Promise<T> {
  return runInstallFilesystemTransaction(async () => {
    const activation = await activate()
    try {
      await finalize(activation.value)
    } catch (error) {
      await activation.rollback()
      throw error
    }
    await activation.commit()
    return activation.value
  })
}
