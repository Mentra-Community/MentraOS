let lastInstallOperationId = 0
let installFilesystemTail: Promise<void> = Promise.resolve()

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
