/**
 * session facade — `toolkit.session`: the cloud-v2 live-session surface island
 * now owns (keystone #5). Exposes the connection status read-model (status +
 * audio transport, projected from the island-owned cloud-status store) and the
 * liveness flag.
 *
 * `account.*` operations route through the now-island RestComms (the account REST
 * calls moved in with the settings+RestComms keystone), so they're adapter-free.
 * (`requestExport` is a host UI navigation flow with no backend method yet, so it
 * is not surfaced here.)
 */
import restComms from "../services/RestComms"
import {cloudClientService} from "../services/CloudClientService"
import {useCloudClientStatusStore} from "../stores/cloudClientStatus"
import type {CloudClientStatusSnapshot} from "../runtime/config"

function project(): CloudClientStatusSnapshot {
  const s = useCloudClientStatusStore.getState()
  return {status: s.status, audioTransport: s.audioTransport}
}

export const session = {
  /** Current cloud live-session status (connection state + audio transport). */
  status: (): CloudClientStatusSnapshot => project(),
  /** Subscribe to cloud session-status changes; returns an unsubscribe. */
  onStatus: (cb: (status: CloudClientStatusSnapshot) => void): (() => void) => {
    // Dedupe: fire only when the projected {status, audioTransport} changes.
    let last = JSON.stringify(project())
    return useCloudClientStatusStore.subscribe(() => {
      const snap = project()
      const key = JSON.stringify(snap)
      if (key === last) return
      last = key
      cb(snap)
    })
  },
  /** Whether the live-session handshake has completed. */
  isConnected: (): boolean => cloudClientService.isConnected(),

  /** Identity / account operations (island-owned RestComms). */
  account: {
    /** Request account deletion — the backend emails a confirmation code. */
    delete: () => restComms.requestAccountDeletion(),
    /** Confirm a pending account deletion with the emailed code. */
    confirmDelete: (requestId: string, confirmationCode: string) =>
      restComms.confirmAccountDeletion(requestId, confirmationCode),
  },
}
