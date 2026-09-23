/** Synchronous initial replay prevents a snapshot/read-listen gap across the bridge adapter. */
export class RevisionedSnapshot<T extends {readonly revision: number}> {
  private listeners = new Map<(snapshot: T) => void, number>()
  private notifying = false
  private pending: T[] = []

  constructor(private value: T) {}

  snapshot = (): T => this.value

  subscribe = (listener: (snapshot: T) => void): (() => void) => {
    this.listeners.set(listener, this.value.revision)
    try {
      listener(this.value)
    } catch (error) {
      this.listeners.delete(listener)
      throw error
    }
    return () => this.listeners.delete(listener)
  }

  publish(value: Omit<T, "revision">): void {
    this.value = {...value, revision: this.value.revision + 1} as T
    this.pending.push(this.value)
    if (this.notifying) return
    this.notifying = true
    try {
      while (this.pending.length) {
        const next = this.pending.shift()!
        for (const [listener] of [...this.listeners]) {
          const lastRevision = this.listeners.get(listener)
          if (lastRevision === undefined || lastRevision >= next.revision) continue
          this.listeners.set(listener, next.revision)
          try {
            listener(next)
          } catch (error) {
            // A view cannot prevent the provider or other observers from seeing device progress.
            console.warn("Firmware update observer failed", error)
          }
        }
      }
    } finally {
      this.notifying = false
    }
  }
}
