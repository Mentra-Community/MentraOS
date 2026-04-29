import {create} from "zustand"

/**
 * Zustand store — the bridge between the always-on GlassesController and
 * the React UI. The controller writes; React pages read.
 *
 * Pages do NOT subscribe to the session directly; they subscribe to slices
 * of this store. Closing a page does not unsubscribe from glasses events;
 * the controller keeps running.
 *
 * Settings the user toggles in UI (mirrorToGlasses) flow the other direction:
 * UI mutates the store, controller reads on the next event.
 */
interface AppStore {
  // Transcription state.
  liveTranscript: string
  history: string[]
  setLiveTranscript: (s: string) => void
  appendHistory: (s: string) => void
  clearHistory: () => void

  // Last button press shown in CaptionsPage's footer.
  lastButton: string
  setLastButton: (s: string) => void

  // Settings the controller observes — UI mutates these, controller reads.
  mirrorToGlasses: boolean
  setMirrorToGlasses: (v: boolean) => void
}

export const useAppStore = create<AppStore>((set) => ({
  liveTranscript: "",
  history: [],
  setLiveTranscript: (s) => set({liveTranscript: s}),
  appendHistory: (s) => set((st) => ({history: [...st.history, s]})),
  clearHistory: () => set({history: [], liveTranscript: ""}),

  lastButton: "",
  setLastButton: (s) => set({lastButton: s}),

  mirrorToGlasses: true,
  setMirrorToGlasses: (v) => set({mirrorToGlasses: v}),
}))
