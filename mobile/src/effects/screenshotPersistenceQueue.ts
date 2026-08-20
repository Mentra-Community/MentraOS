let persistenceTail: Promise<void> = Promise.resolve()

/**
 * Serialize screenshot file writes, URI updates, and cleanup. Capture itself
 * stays concurrent so gesture handlers still begin it synchronously.
 */
export function enqueueScreenshotPersistence<T>(task: () => Promise<T>): Promise<T> {
  const result = persistenceTail.then(task)
  persistenceTail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}
