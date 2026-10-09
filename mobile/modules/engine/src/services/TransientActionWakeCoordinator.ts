/**
 * Invocation-scoped ownership for transient action wakes.
 *
 * A transient action may need to spawn a miniapp background context, but that
 * context must not appear as user activity and must survive until every
 * concurrent invocation settles. If the user promotes the context by opening
 * the miniapp, releasing the final transient lease leaves it running.
 */
export interface TransientActionWakeDependencies {
  isContextRunning(packageName: string): boolean
  isProjectedRunning(packageName: string): boolean
  ensureConnectedHidden(packageName: string): Promise<void>
  stopContext(packageName: string): Promise<void>
}

interface WakeState {
  leases: Set<symbol>
  ownsContext: boolean
  teardown?: Promise<void>
}

export class TransientActionWakeCoordinator {
  private readonly states = new Map<string, WakeState>()

  constructor(private readonly deps: TransientActionWakeDependencies) {}

  async acquire(packageName: string): Promise<() => Promise<void>> {
    const token = Symbol(packageName)
    let state = this.states.get(packageName)
    // A final release may already be killing the invocation-owned context.
    // Join that teardown before acquiring a fresh lease so the old stop cannot
    // race with (and kill) the next invocation's newly-adopted context.
    if (state?.teardown) {
      await state.teardown
      return this.acquire(packageName)
    }
    if (!state) {
      state = {
        leases: new Set(),
        ownsContext: !this.deps.isContextRunning(packageName),
      }
      this.states.set(packageName, state)
    }
    state.leases.add(token)

    try {
      await this.deps.ensureConnectedHidden(packageName)
    } catch (error) {
      await this.release(packageName, token)
      throw error
    }

    let released = false
    return async () => {
      if (released) return
      released = true
      await this.release(packageName, token)
    }
  }

  /** Context teardown already owns cleanup; pending releases become no-ops. */
  forget(packageName: string): void {
    this.states.delete(packageName)
  }

  private async release(packageName: string, token: symbol): Promise<void> {
    const state = this.states.get(packageName)
    if (!state || !state.leases.delete(token) || state.leases.size > 0) return

    if (
      state.ownsContext &&
      this.deps.isContextRunning(packageName) &&
      !this.deps.isProjectedRunning(packageName)
    ) {
      state.teardown = this.deps.stopContext(packageName).finally(() => {
        if (this.states.get(packageName) === state) this.states.delete(packageName)
      })
      await state.teardown
      return
    }
    this.states.delete(packageName)
  }
}
