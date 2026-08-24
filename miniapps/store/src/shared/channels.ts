import type {Rpc} from "@mentra/miniapp/ui"
import type {StoreSnapshot} from "./types"

export interface StoreChannels {
  "store:snapshot": StoreSnapshot
  "store:refresh": Rpc<{query?: string}, StoreSnapshot>
  "store:install": Rpc<{packageName: string; query?: string}, StoreSnapshot>
  "store:uninstall": Rpc<{packageName: string; query?: string}, StoreSnapshot>
  "store:open": Rpc<{packageName: string; query?: string}, StoreSnapshot>
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<StoreChannels>
}
