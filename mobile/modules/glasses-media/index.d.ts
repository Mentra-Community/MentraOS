/** Print glasses-media's and acs-meeting's native logs to the console, which bug reports upload. Idempotent. */
export function installNativeLogConsole(): void

/** Shared native association owner for the local glasses hotspot. */
export const glassesHotspot: {
  join(
    id: string,
    ssid: string,
    password: string,
    gateway?: string,
    purpose?: "outgoing-client" | "incoming-server",
  ): Promise<string>
  leave(id: string, waitForInternet?: boolean): Promise<void>
  /** A join with this id is waiting for Local Network access, which the person may have denied. */
  onPermissionRequired(listener: (id: string) => void): {remove(): void}
}
