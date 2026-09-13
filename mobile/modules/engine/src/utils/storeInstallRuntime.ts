export interface StoreInstallRuntimeLauncher {
  isRunning(packageName: string): boolean
  stop(packageName: string): Promise<void>
  ensureRunning(packageName: string): Promise<unknown>
}

export interface StoreInstallRuntimeRecovery {
  /** Restore the active-version pointer captured before installation. */
  restorePreviousVersion: () => Promise<void> | void
  onRecoveryError?: (error: unknown) => void
}

/**
 * Run an atomic bundle install without leaving an old JS context alive.
 *
 * If the target was running, its context is stopped before activation and
 * relaunched afterward. A transient post-install launch failure is retried
 * once. If the new version still cannot launch, the caller-provided recovery
 * restores the prior active-version pointer before the old context is started.
 */
export async function installWithRuntimeReload<T>(
  launcher: StoreInstallRuntimeLauncher,
  packageName: string,
  install: () => Promise<T>,
  recovery: StoreInstallRuntimeRecovery,
): Promise<T> {
  const restartRequired = launcher.isRunning(packageName)
  if (!restartRequired) return install()

  await launcher.stop(packageName)
  let result: T
  try {
    result = await install()
  } catch (installError) {
    if (!launcher.isRunning(packageName)) {
      try {
        await launcher.ensureRunning(packageName)
      } catch (restoreError) {
        recovery.onRecoveryError?.(restoreError)
      }
    }
    throw installError
  }

  try {
    await launcher.ensureRunning(packageName)
    return result
  } catch (firstLaunchError) {
    // Some launch failures are reported after the context has already entered
    // the running set. In that case activation succeeded and the Store should
    // not report a false failure.
    if (launcher.isRunning(packageName)) return result

    // Retry once for transient spawn failures. A successful retry means the
    // newly installed version is active and the operation genuinely succeeded.
    try {
      await launcher.ensureRunning(packageName)
      return result
    } catch {
      if (launcher.isRunning(packageName)) return result
      try {
        await recovery.restorePreviousVersion()
        await launcher.ensureRunning(packageName)
      } catch (recoveryError) {
        recovery.onRecoveryError?.(recoveryError)
      }
      // The new version never became usable. Its files remain installed, but
      // activation was rolled back, so surface the launch failure to the Store.
      throw firstLaunchError
    }
  }
}
