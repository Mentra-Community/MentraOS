/**
 * session facade — `engine.session`: the cloud-v2 live-session surface engine
 * now owns (keystone #5). Exposes the connection status read-model (status +
 * audio transport, projected from the engine-owned cloud-status store) and the
 * liveness flag.
 *
 * `account.*` operations route through the now-engine RestComms (the account REST
 * calls moved in with the settings+RestComms keystone), so they're adapter-free.
 * (`requestExport` is a host UI navigation flow with no backend method yet, so it
 * is not surfaced here.)
 */
import restComms from "../services/RestComms"
import {cloudClientService} from "../services/CloudClientService"
import {useCloudClientStatusStore} from "../stores/cloudClientStatus"
import {useConnectionStore} from "../stores/connection"
import type {WebSocketStatus} from "../stores/connection"
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

  /**
   * Legacy Cloud-V1 websocket status (the cloud-SDK-app bridge socket, fed by the
   * host WebSocketManager into the engine-owned connection store). This is a
   * different socket than `status()` (the cloud-v2 runtime); the host connection
   * banners render this one.
   */
  legacyWebsocketStatus: (): WebSocketStatus => useConnectionStore.getState().status,
  /** Subscribe to legacy websocket status changes; fires only when it changes. Returns an unsubscribe. */
  onLegacyWebsocketStatus: (cb: (status: WebSocketStatus) => void): (() => void) => {
    let last = useConnectionStore.getState().status
    return useConnectionStore.subscribe((state) => {
      if (state.status === last) return
      last = state.status
      cb(state.status)
    })
  },

  /** Identity / account operations (engine-owned RestComms). */
  account: {
    /** Request account deletion — the backend emails a confirmation code. */
    delete: () => restComms.requestAccountDeletion(),
    /** Confirm a pending account deletion with the emailed code. */
    confirmDelete: (requestId: string, confirmationCode: string) =>
      restComms.confirmAccountDeletion(requestId, confirmationCode),
  },
}
