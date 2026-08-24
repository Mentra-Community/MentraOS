export interface StoreInstallRuntimeLauncher {
  isRunning(packageName: string): boolean
  stop(packageName: string): Promise<void>
  ensureRunning(packageName: string): Promise<unknown>
}

/**
 * Run an atomic bundle install without leaving an old JS context alive.
 *
 * If the target was running, its context is stopped before activation and
 * relaunched afterward. A failed install restores whichever version remains
 * active in the registry (the prior version before activation, or the new
 * version if activation completed but relaunch failed).
 */
export async function installWithRuntimeReload<T>(
  launcher: StoreInstallRuntimeLauncher,
  packageName: string,
  install: () => Promise<T>,
  onRestoreError?: (error: unknown) => void,
): Promise<T> {
  const restartRequired = launcher.isRunning(packageName)
  if (!restartRequired) return install()

  await launcher.stop(packageName)
  try {
    const result = await install()
    await launcher.ensureRunning(packageName)
    return result
  } catch (error) {
    if (!launcher.isRunning(packageName)) {
      try {
        await launcher.ensureRunning(packageName)
      } catch (restoreError) {
        onRestoreError?.(restoreError)
      }
    }
    throw error
  }
}
