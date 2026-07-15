/**
 * Merge partial patches and flush once after `delayMs` of quiet time.
 * Uses global setTimeout so Jest fake timers can advance debounced writes.
 */
export function createDebouncedPatchFlusher<T extends Record<string, unknown>>(
  flush: (patch: T) => void,
  delayMs: number,
) {
  let pending = {} as T
  let timer: ReturnType<typeof setTimeout> | null = null

  const schedule = (callback: () => void) => {
    timer = setTimeout(callback, delayMs) as ReturnType<typeof setTimeout>
  }

  return (patch: Partial<T>) => {
    pending = {...pending, ...patch}
    if (timer != null) {
      clearTimeout(timer)
    }
    schedule(() => {
      timer = null
      const batch = pending
      pending = {} as T
      if (Object.keys(batch).length > 0) flush(batch)
    })
  }
}
