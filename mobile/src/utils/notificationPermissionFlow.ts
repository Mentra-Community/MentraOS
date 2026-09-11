export interface AppStateSubscription {
  remove(): void
}

/** Wait for a Settings round-trip, then return the permission's fresh value. */
export function checkPermissionAfterSettingsReturn(
  openSettings: () => Promise<unknown>,
  checkPermission: () => Promise<boolean>,
  subscribe: (listener: (state: string) => void) => AppStateSubscription,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let leftApp = false
    let settled = false
    let subscription: AppStateSubscription | undefined

    const cleanup = () => subscription?.remove()
    const finish = (granted: boolean) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(granted)
    }

    subscription = subscribe((nextState) => {
      if (nextState === "inactive" || nextState === "background") {
        leftApp = true
        return
      }
      if (nextState !== "active" || !leftApp) return
      void checkPermission().then(finish, (error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      })
    })

    void openSettings().catch((error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
  })
}
