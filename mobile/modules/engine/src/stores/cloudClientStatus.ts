/**
 * Cloud-client runtime status store — moved into engine so engine owns the
 * cloud-v2 runtime status (connection status + audio transport). Re-exported
 * through the host's `@/stores/cloudClientStatus` shim so the app keeps its
 * imports, and surfaced as `engine.stores.cloudClientStatus`.
 */
import {create} from "zustand"

import type {RuntimeAudioTransport, RuntimeSnapshot, RuntimeStatus} from "@mentra/cloud-client/react-native"

const initialSnapshot: RuntimeSnapshot = {
  status: "disconnected",
  audioTransport: "none",
}

export interface CloudClientStatusState extends RuntimeSnapshot {
  lastChangedAt: Date | null
  setSnapshot: (snapshot: RuntimeSnapshot) => void
  reset: () => void
}

export const useCloudClientStatusStore = create<CloudClientStatusState>((set) => ({
  ...initialSnapshot,
  lastChangedAt: null,
  setSnapshot: (snapshot) =>
    set({
      ...snapshot,
      lastChangedAt: new Date(),
    }),
  reset: () =>
    set({
      ...initialSnapshot,
      lastChangedAt: null,
    }),
}))

export type {RuntimeAudioTransport, RuntimeSnapshot, RuntimeStatus}
