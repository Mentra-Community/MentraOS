import type {ClientApp} from "@mentra/engine"
import {create} from "zustand"

import type {DefaultMiniappsState} from "@/stores/defaultMiniapps"

/**
 * A miniapp the person opened before it could open: a default still installing, or a miniapp that is updating. Its
 * splash stays up (effects/MiniappOpenWait.tsx) until it can, then `open` opens it in place.
 */
export interface MiniappOpenWait {
  /** Each wait has its own: a finished or cancelled wait never clears a newer one. */
  id: number
  packageName: string
  name: string
  iconUrl?: string
  /** Open the miniapp, now installed and not updating, as a tap would, with no opening animation. */
  open: (app: ClientApp) => Promise<void>
}

export const useMiniappOpenWaitStore = create<{wait: MiniappOpenWait | null}>(() => ({wait: null}))

let nextId = 1

/** Show `app`'s splash until it can open, then open it with `open`. Replaces any wait already shown. */
export function startMiniappOpenWait(app: ClientApp, open: (app: ClientApp) => Promise<void>): void {
  useMiniappOpenWaitStore.setState({
    wait: {
      id: nextId++,
      packageName: app.packageName,
      name: app.name,
      ...(app.logoUrl ? {iconUrl: app.logoUrl} : {}),
      open,
    },
  })
}

/** Close the wait `id` (the current one when omitted): the person left it, or the miniapp opened. */
export function endMiniappOpenWait(id?: number): void {
  const {wait} = useMiniappOpenWaitStore.getState()
  if (wait && (id === undefined || wait.id === id)) useMiniappOpenWaitStore.setState({wait: null})
}

/**
 * What the waiting splash shows. `ready`: it can open. `updating`: an update is being installed. `installing`: a
 * default is being installed. `waiting`: its download waits for a connection. `failed`: nothing will install it.
 */
export type MiniappOpenWaitPhase = "ready" | "updating" | "installing" | "waiting" | "failed"

export function miniappOpenWaitPhase(
  packageName: string,
  installed: ClientApp | undefined,
  defaults: Pick<DefaultMiniappsState, "status" | "pending" | "failed">,
): MiniappOpenWaitPhase {
  if (installed) return installed.updating ? "updating" : "ready"
  if (defaults.failed.includes(packageName)) return "failed"
  // A default installs before it leaves `pending`, so one that is neither installed nor pending won't install.
  if (!defaults.pending.includes(packageName)) return defaults.status === "waiting" ? "waiting" : "failed"
  return defaults.status === "waiting" ? "waiting" : "installing"
}
