/** A normal deferral: an automatic update must leave this running session alone. */
export class MiniappRunningError extends Error {
  constructor(packageName: string) {
    super(`${packageName} is running; its automatic update will be retried later`)
    this.name = "MiniappRunningError"
  }
}

export interface StoreInstallRuntimeLauncher {
  pauseLaunches(packageName: string): Promise<() => void>
  isRunning(packageName: string): boolean
  stop(packageName: string): Promise<void>
  ensureRunning(packageName: string, hints?: undefined, options?: {checkForUpdate?: boolean}): Promise<unknown>
}

/**
 * Stop a running context around the shared atomic installer, then restart it.
 * Launches of the package wait until the install commits or rolls back.
 * Installation failure leaves the previous files selected. Once installation
 * commits, a runtime error does not undo the installed release (including an
 * equal-version replacement).
 */
export async function installWithRuntimeReload<T>(
  launcher: StoreInstallRuntimeLauncher,
  packageName: string,
  install: () => Promise<T>,
): Promise<T> {
  const resumeLaunches = await launcher.pauseLaunches(packageName)
  const restartRequired = launcher.isRunning(packageName)
  try {
    if (restartRequired) await launcher.stop(packageName)
    return await install()
  } finally {
    resumeLaunches()
    if (restartRequired && !launcher.isRunning(packageName)) {
      try {
        // What was just installed starts again: it doesn't wait for an update check, as an open does.
        await launcher.ensureRunning(packageName, undefined, {checkForUpdate: false})
      } catch (error) {
        // Launch errors are reported by the runtime; they are not an archive
        // installation failure and must not claim that committed files rolled back.
        console.warn(`Miniapp ${packageName} could not restart after installation`, error)
      }
    }
  }
}
