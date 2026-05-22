import {create} from "zustand"
import {subscribeWithSelector} from "zustand/middleware"
import {BluetoothStatus} from "@mentra/bluetooth-sdk-internal"

interface CoreState extends BluetoothStatus {
  setCoreInfo: (info: Partial<BluetoothStatus>) => void
  reset: () => void
}

const initialState: BluetoothStatus = {
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
