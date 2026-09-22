interface Dependencies {
  isEnabled: () => boolean
  wasEnabled: () => boolean
  saveEnabled: (enabled: boolean) => void
  setHidden: (hidden: boolean) => void
  clearRunningState: () => void
  install: () => Promise<void>
  stop: () => Promise<void>
}

/** Serializes visibility changes with miniapp installation and teardown. */
export class IosMiniappVisibility {
  private pending: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly deps: Dependencies) {}

  /** Hide immediately, including before the registry publishes cached entries. */
  applyRestriction(): void {
    if (this.disposed || this.deps.isEnabled()) return
    this.deps.setHidden(true)
    this.deps.clearRunningState()
    this.deps.saveEnabled(false)
  }

  reconcile(): Promise<void> {
    this.applyRestriction()
    this.pending = this.pending
      .catch(() => {})
      .then(async () => {
        if (this.disposed) return
        if (!this.deps.isEnabled()) {
          await this.hideAndStop()
          return
        }
        // Persist the last effective policy separately from the ordinary home
        // hide flag. An opt-in clears the old forced flag once, not every launch.
        await this.deps.install()
        if (this.disposed) return
        if (!this.deps.isEnabled()) {
          await this.hideAndStop()
          return
        }
        if (!this.deps.wasEnabled()) this.deps.setHidden(false)
        this.deps.saveEnabled(true)
      })
    return this.pending
  }

  dispose(): void {
    this.disposed = true
  }

  private async hideAndStop(): Promise<void> {
    this.applyRestriction()
    await this.deps.stop()
    if (!this.disposed) this.deps.saveEnabled(false)
  }
}
