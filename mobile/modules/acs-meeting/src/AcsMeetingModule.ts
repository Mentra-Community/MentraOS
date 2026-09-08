import {NativeModule, requireNativeModule} from "expo"

import type {AcsMeetingJoinOptions, AcsMeetingModuleEvents, AcsMeetingState} from "./AcsMeeting.types"

declare class AcsMeetingNativeModule extends NativeModule<AcsMeetingModuleEvents> {
  join(options: AcsMeetingJoinOptions): Promise<AcsMeetingState>
  leave(): Promise<void>
  setMuted(muted: boolean): Promise<AcsMeetingState>
  setAudioSource(source: "glasses" | "phone"): Promise<AcsMeetingState>
  updateVideoSource(whepUrl: string): Promise<void>
  /** Force a WHEP rebuild on the current URL (phone changed networks). */
  restartVideoSource(): Promise<void>
  /** SoftAP: join the glasses hotspot as a scoped network; resolves to the phone's IPv4 on it. Android only. */
  joinScopedNetwork(ssid: string, passphrase: string): Promise<string>
  leaveScopedNetwork(): Promise<void>
  /** SoftAP: TCP-probe the hotspot gateway over the scoped network. */
  probeScopedGateway(): Promise<{reachable: boolean; detail: string}>
  getState(): Promise<AcsMeetingState>
}

export default requireNativeModule<AcsMeetingNativeModule>("MentraAcsMeeting")
