import {create} from "zustand"

import type {RuntimeAudioTransport, RuntimeSnapshot, RuntimeStatus} from "@mentra/cloud-client/react-native"

const initialSnapshot: RuntimeSnapshot = {
  status: "disconnected",
  audioTransport: "none",
}

interface CloudClientStatusState extends RuntimeSnapshot {
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
