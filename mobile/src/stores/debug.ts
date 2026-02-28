// debug store for storing debug values only!

import {create} from "zustand"
import {subscribeWithSelector} from "zustand/middleware"

interface DebugStatus {
  micDataRecvd: boolean
}

interface DebugState extends DebugStatus {
  setDebugInfo: (info: Partial<DebugStatus>) => void
  reset: () => void
}

const initialState: DebugStatus = {
  // state:
  micDataRecvd: false,
}

export const useDebugStore = create<DebugState>()(
  subscribeWithSelector((set) => ({
    ...initialState,

    setDebugInfo: (info) => set((state) => ({...state, ...info})),

    reset: () => set(initialState),
  })),
)
