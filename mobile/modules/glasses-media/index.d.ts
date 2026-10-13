/** Shared native association owner for the local glasses hotspot. */
export const glassesHotspot: {
  join(
    id: string,
    ssid: string,
    password: string,
    gateway?: string,
    purpose?: "outgoing-client" | "incoming-server",
  ): Promise<string>
  leave(id: string): Promise<void>
}
