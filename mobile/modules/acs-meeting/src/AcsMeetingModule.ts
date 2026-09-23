import {NativeModule, requireNativeModule} from "expo"

import type {AcsMeetingJoinOptions, AcsMeetingModuleEvents, AcsMeetingState} from "./AcsMeeting.types"

declare class AcsMeetingNativeModule extends NativeModule<AcsMeetingModuleEvents> {
  supportsTeamsIdentity(): boolean
  join(options: AcsMeetingJoinOptions): Promise<AcsMeetingState>
  /** Sign in to ACS before SoftAP so Teams is not resolved through glasses DNS. */
  prepareAgent(options: {
    token: string
    displayName?: string
    identityMode?: "guest" | "teams-user"
  }): Promise<AcsMeetingState>
  leave(): Promise<void>
  admitParticipant?(participantId: string): Promise<void>
  /**
   * Leave, and resolve only once the hang-up, the agent disposal, and the network releases have
   * finished. Use this explicit barrier across platforms; Android `leave()` only queues cleanup.
   */
  leaveAndAwait(options: {timeoutMs: number}): Promise<{completed: boolean}>
  setMuted(muted: boolean): Promise<AcsMeetingState>
  /**
   * Stop or resume the outgoing video stream (ACS `stopVideo`/`startVideo`). The call, the glasses
   * media source and the preview tap stay up; frames are dropped before ACS while stopped.
   */
  setVideoEnabled(enabled: boolean): Promise<AcsMeetingState>
  setAudioSource(source: "glasses" | "phone"): Promise<AcsMeetingState>
  updateVideoSource(whepUrl: string): Promise<void>
  /** Force a WHEP rebuild on the current URL (phone changed networks). */
  restartVideoSource(): Promise<void>
  /**
   * SoftAP: destroy the current ingest listener generation and bind a new one.
   * Resolves with the new URL the glasses must publish to. Rejects rather than
   * reuse a stale listener.
   */
  rebindSoftApIngest(): Promise<string>
  /** SoftAP: join the glasses hotspot; resolves to the phone's IPv4 on it. */
  joinScopedNetwork(ssid: string, passphrase: string): Promise<string>
  /** iOS: verify DHCP against the gateway advertised by the glasses before resolving. */
  joinScopedNetworkWithGateway?(ssid: string, passphrase: string, gateway: string): Promise<string>
  beginTrace(traceId: string): Promise<void>
  leaveScopedNetwork(): Promise<void>
  cancelScopedNetworkJoin?(): Promise<void>
  awaitDefaultNetworkAfterHotspot?(): Promise<{usable: boolean; detail: string; transport: string}>
  /** SoftAP: TCP-probe the hotspot gateway over the scoped network. */
  probeScopedGateway(): Promise<{reachable: boolean; detail: string}>
  getState(): Promise<AcsMeetingState>
}

export default requireNativeModule<AcsMeetingNativeModule>("MentraAcsMeeting")
