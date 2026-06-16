/**
 * session facade — `toolkit.session`: the cloud-v2 live-session surface island
 * now owns (keystone #5). Exposes the connection status read-model (status +
 * audio transport, projected from the island-owned cloud-status store) and the
 * liveness flag.
 *
 * Account operations (`account.delete()` / `account.requestExport()` from the
 * Phase-1 contract) are still host RestComms calls; they land here when the
 * account/identity domain moves into island. The cloud-client `core` surface
 * exposes no account methods today.
 */
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
  onStatus: (cb: (status: CloudClientStatusSnapshot) => void): (() => void) =>
    useCloudClientStatusStore.subscribe(() => cb(project())),
  /** Whether the live-session handshake has completed. */
  isConnected: (): boolean => cloudClientService.isConnected(),
}
