import {create} from "zustand"
import {subscribeWithSelector} from "zustand/middleware"
import type {PublicBluetoothStatus} from "@mentra/bluetooth-sdk"

export interface CoreState extends PublicBluetoothStatus {
  setCoreInfo: (info: Partial<PublicBluetoothStatus>) => void
  reset: () => void
}

const initialState: PublicBluetoothStatus = {
  // state:
  searching: false,
  searchingController: false,
  micRanking: ["glasses", "phone", "bluetooth", "bluetoothClassic"],
  systemMicUnavailable: false,
  currentMic: null,
  searchResults: [],
  wifiScanResults: [],
  lastLog: [],
  otherBtConnected: false,
  galleryModeEnabled: true,
}

export const useCoreStore = create<CoreState>()(
  subscribeWithSelector((set) => ({
    ...initialState,

    setCoreInfo: (info) => set((state) => ({...state, ...info})),

    reset: () => set(initialState),
  })),
)
