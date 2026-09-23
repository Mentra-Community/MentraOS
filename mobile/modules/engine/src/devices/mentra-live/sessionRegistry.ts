import {ota} from "../../facades/ota"
import {MentraLiveOtaSession} from "./session"

// The native Live coordinator supports one device. All public React views share its flow owner.
let session: MentraLiveOtaSession | null = null

export function getMentraLiveOtaSession(): MentraLiveOtaSession {
  if (!session || session.isDisposed) session = new MentraLiveOtaSession(ota)
  return session
}

export function releaseMentraLiveOtaSession(owner: MentraLiveOtaSession): void {
  if (session !== owner || owner.snapshot().page === "progress" || owner.chain.isOtaAutoChainActive()) return
  owner.dispose()
  session = null
}
