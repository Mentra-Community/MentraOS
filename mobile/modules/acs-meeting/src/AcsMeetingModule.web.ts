import type {AcsMeetingJoinOptions, AcsMeetingState} from "./AcsMeeting.types"

function unavailable(): never {
  throw new Error("ACS meeting is not available on web")
}

export default {
  async join(_options: AcsMeetingJoinOptions): Promise<AcsMeetingState> {
    unavailable()
  },
  async leave(): Promise<void> {
    unavailable()
  },
  async setMuted(_muted: boolean): Promise<AcsMeetingState> {
    unavailable()
  },
  async setAudioSource(_source: "glasses" | "phone"): Promise<AcsMeetingState> {
    unavailable()
  },
  async updateVideoSource(_whepUrl: string): Promise<void> {
    unavailable()
  },
  async restartVideoSource(): Promise<void> {
    unavailable()
  },
  async getState(): Promise<AcsMeetingState> {
    return {state: "idle", muted: false}
  },
  addListener() {
    return {remove() {}}
  },
  removeListeners() {},
}
