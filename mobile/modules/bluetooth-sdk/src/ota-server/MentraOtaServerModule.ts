import {NativeModule, requireNativeModule} from "expo"

import type {MentraOtaServerModuleEvents, OtaServerResult} from "./MentraOtaServer.types"

declare class MentraOtaServerModule extends NativeModule<MentraOtaServerModuleEvents> {
  isSupported(): Promise<boolean>
  /**
   * Serve `manifestJson` at /version.json and `artifactPaths` (sha256 -> local file path)
   * at /artifacts/<sha256>. Pass `host` when the caller knows the authoritative local
   * address (e.g. from the scoped hotspot network); omit to fall back to interface
   * scanning. Returns the URLs to hand to the glasses via ota_start.
   */
  startOtaServer(
    manifestJson: string,
    artifactPaths: Record<string, string>,
    host?: string | null,
  ): Promise<OtaServerResult>
  stopOtaServer(): Promise<void>
  startHealthKeepalive(url: string, intervalMs: number): Promise<void>
  stopHealthKeepalive(): Promise<void>
  /** Wait for iPhone Wi-Fi (`en0`) to acquire an address on the glasses gateway subnet. */
  waitForWifiAddress(gateway: string, timeoutMs: number): Promise<string>
  downloadArtifact(source: string, destination: string): Promise<{statusCode: number; bytesWritten: number}>
}

export default requireNativeModule<MentraOtaServerModule>("MentraOtaServer")
