import type {AcsMeetingJoinOptions, AcsMeetingState} from "./AcsMeeting.types"

function unavailable(): never {
  throw new Error("ACS meeting is not available on web")
}

export default {
  async join(_options: AcsMeetingJoinOptions): Promise<AcsMeetingState> {
    unavailable()
  },
  async prepareAgent(_options: {token: string; displayName?: string}): Promise<AcsMeetingState> {
    unavailable()
  },
  async leave(): Promise<void> {
    unavailable()
  },
  async leaveAndAwait(_options: {timeoutMs: number}): Promise<{completed: boolean}> {
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
  async joinScopedNetwork(_ssid: string, _passphrase: string): Promise<string> {
    unavailable()
  },
  async leaveScopedNetwork(): Promise<void> {},
  async probeScopedGateway(): Promise<{reachable: boolean; detail: string}> {
    return {reachable: false, detail: "no scoped network on web"}
  },
  async getState(): Promise<AcsMeetingState> {
    return {state: "idle", muted: false}
  },
  addListener() {
    return {remove() {}}
  },
  removeListeners() {},
}
