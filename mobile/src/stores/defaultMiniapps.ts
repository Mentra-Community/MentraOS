import {create} from "zustand"

/**
 * The deployment's default miniapps still to install (services/miniapps/defaultMiniapps.ts). `installing`: these are
 * being installed now. `waiting`: these (or, with none, the list itself) wait for a connection. `idle`: nothing is
 * missing.
 */
export interface DefaultMiniappsState {
  status: "idle" | "installing" | "waiting"
  pending: string[]
}

export const DEFAULT_MINIAPPS_IDLE: DefaultMiniappsState = {status: "idle", pending: []}

export const useDefaultMiniappsStore = create<DefaultMiniappsState>(() => DEFAULT_MINIAPPS_IDLE)
