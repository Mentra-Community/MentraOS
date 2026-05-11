import {create} from "zustand"
import {subscribeWithSelector} from "zustand/middleware"
import {CoreStatus} from "@mentra/bluetooth-sdk"

interface CoreState extends CoreStatus {
  setCoreInfo: (info: Partial<CoreStatus>) => void
  reset: () => void
}

const initialState: CoreStatus = {
  // state:
  searching: false,
  searchingController: false,
  micRanking: ["glasses", "phone", "bluetooth"],
  systemMicUnavailable: false,
  currentMic: null,
  searchResults: [],
  wifiScanResults: [],
  lastLog: [],
  otherBtConnected: false,
}

export const useCoreStore = create<CoreState>()(
  subscribeWithSelector((set) => ({
    ...initialState,

    setCoreInfo: (info) => set((state) => ({...state, ...info})),

    reset: () => set(initialState),
  })),
)
