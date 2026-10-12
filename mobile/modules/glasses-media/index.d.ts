/** Target SSID, DHCP client, attached Wi-Fi interface and source-bound gateway verification. */
export const glassesHotspot: Readonly<{
  waitForMacAssociation(sessionId: string, ssid: string, gateway: string, timeoutMs: number): Promise<string>
  verifiedMacAddress(sessionId: string): Promise<string | null>
  releaseMacAssociation(sessionId: string): Promise<void>
}>
