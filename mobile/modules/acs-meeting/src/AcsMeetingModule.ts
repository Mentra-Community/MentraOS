import {NativeModule, requireNativeModule} from "expo"

import type {AcsMeetingJoinOptions, AcsMeetingModuleEvents, AcsMeetingState} from "./AcsMeeting.types"

declare class AcsMeetingNativeModule extends NativeModule<AcsMeetingModuleEvents> {
  join(options: AcsMeetingJoinOptions): Promise<AcsMeetingState>
  leave(): Promise<void>
  setMuted(muted: boolean): Promise<AcsMeetingState>
  setAudioSource(source: "glasses" | "phone"): Promise<AcsMeetingState>
  updateVideoSource(whepUrl: string): Promise<void>
  getState(): Promise<AcsMeetingState>
}

export default requireNativeModule<AcsMeetingNativeModule>("MentraAcsMeeting")
