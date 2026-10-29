/**
 * @fileoverview A bounded, in-process memory of which keys were checked recently.
 *
 * `begin(key)` says whether a check of `key` should run now: not when one began
 * within `intervalMs`. It records the attempt, so concurrent callers for the same
 * key run one check. `forget(key)` lets the next call check again (after a failed
 * check). At most `maxEntries` keys are kept; the least recently checked go first,
 * so memory stays bounded however many people a process sees.
 */

export class RecentChecks {
  private readonly checkedAt = new Map<string, number>()

  constructor(
    private readonly intervalMs: number,
    private readonly maxEntries: number,
  ) {}

  /** Whether `key` is due a check at `now`; if it is, the check is recorded as begun. */
  begin(key: string, now: number = Date.now()): boolean {
    const last = this.checkedAt.get(key)
    if (last !== undefined && now - last < this.intervalMs) return false
    // Re-inserting moves the key to the end, so the map stays in check order.
    this.checkedAt.delete(key)
    this.checkedAt.set(key, now)
    while (this.checkedAt.size > this.maxEntries) {
      const oldest = this.checkedAt.keys().next().value
      if (oldest === undefined) break
      this.checkedAt.delete(oldest)
    }
    return true
  }

  forget(key: string): void {
    this.checkedAt.delete(key)
  }

  clear(): void {
    this.checkedAt.clear()
  }

  get size(): number {
    return this.checkedAt.size
  }
}
