import type {FleetKeyValueStore} from "../fleetQueue"

/**
 * In-memory `FleetKeyValueStore` for tests. Counts the calls the queue's cost promises are made about, and can be
 * made to fail on write. Pass the same `values` map to a second instance to simulate a process restart.
 */
export class MemoryFleetStore implements FleetKeyValueStore {
  getAllKeysCalls = 0
  /** Keys read through `getString`, in call order. */
  readonly reads: string[] = []
  /** Throws from `set` for a key when this returns true. */
  failSetWhen: ((key: string) => boolean) | null = null
  /** Throws from `remove` for a key when this returns true. */
  failRemoveWhen: ((key: string) => boolean) | null = null
  /** Throws from `getAllKeys` while true. */
  failGetAllKeys = false

  constructor(readonly values = new Map<string, string>()) {}

  getString(key: string): string | undefined {
    this.reads.push(key)
    return this.values.get(key)
  }

  set(key: string, value: string): void {
    if (this.failSetWhen?.(key)) throw new Error("simulated storage failure")
    this.values.set(key, value)
  }

  remove(key: string): void {
    if (this.failRemoveWhen?.(key)) throw new Error("simulated storage failure")
    this.values.delete(key)
  }

  getAllKeys(): string[] {
    this.getAllKeysCalls += 1
    if (this.failGetAllKeys) throw new Error("simulated storage failure")
    return [...this.values.keys()]
  }

  keys(): string[] {
    return [...this.values.keys()]
  }
}
