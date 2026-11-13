import {create} from "zustand"

/** What a default miniapp still to install is called and looks like, from its `miniapp.json`. */
export interface DefaultMiniappListing {
  name: string
  iconUrl: string | null
  version: string
}

/**
 * The deployment's default miniapps still to install (services/miniapps/defaultMiniapps.ts). `installing`: these are
 * being installed now. `waiting`: these (or, with none, the list itself) wait for a connection. `idle`: nothing is
 * missing.
 *
 * `listings` holds the name and icon of each pending default whose `miniapp.json` was read: Home shows those as if they
 * were installed already, and opening one waits for its install. `failed` holds the defaults whose install was refused
 * (a domain, the deployment's policy, an incompatible release): nothing will install them, so opening one says so.
 */
export interface DefaultMiniappsState {
  status: "idle" | "installing" | "waiting"
  pending: string[]
  listings: Record<string, DefaultMiniappListing>
  failed: string[]
}

export const DEFAULT_MINIAPPS_IDLE: DefaultMiniappsState = {status: "idle", pending: [], listings: {}, failed: []}

export const useDefaultMiniappsStore = create<DefaultMiniappsState>(() => DEFAULT_MINIAPPS_IDLE)
