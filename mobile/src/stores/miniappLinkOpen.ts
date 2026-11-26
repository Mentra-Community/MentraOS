import {create} from "zustand"

/**
 * A miniapp a person is opening from a link (services/miniapps/miniappInstallFlow.ts). Its splash shows at once
 * (effects/MiniappLinkOpen.tsx), before the app knows which miniapp the link names, takes the miniapp's name and icon
 * once its `miniapp.json` is read, and stays up while it installs. The miniapp then opens in place of it.
 */
export interface MiniappLinkOpenView {
  /** Each splash has its own, so a new one slides in afresh. */
  id: number
  /** The miniapp, once the link's `miniapp.json` is read. */
  name?: string
  iconUrl?: string
  /** It is being installed; before that the link is still being read. */
  installing: boolean
}

/** One link being opened: the flow that reads it holds this until it ends. */
export interface MiniappLinkOpen {
  /** The person closed the splash: nothing more installs or opens for this link. */
  readonly cancelled: boolean
  /** The link names this miniapp, which installs now. */
  show(miniapp: {name: string; iconUrl: string | null}): void
  /** The miniapp opened, or nothing will: the splash closes once no other link is being opened. */
  end(): void
}

export const useMiniappLinkOpenStore = create<{view: MiniappLinkOpenView | null}>(() => ({view: null}))

interface Handle extends MiniappLinkOpen {
  cancelled: boolean
  /** The miniapp its link names, once known. */
  miniapp?: {name: string; iconUrl: string | null}
}

/** The links being opened now, oldest first. A second tap of a link joins the splash that is up. */
const active = new Set<Handle>()
let nextId = 1

/**
 * The splash shows the miniapp of the oldest link that has named one, so a second link never changes what a splash
 * already says is opening; it takes over once the first has ended.
 */
function render(): void {
  const {view} = useMiniappLinkOpenStore.getState()
  if (active.size === 0) {
    if (view) useMiniappLinkOpenStore.setState({view: null})
    return
  }
  const id = view?.id ?? nextId++
  const shown = [...active].find((handle) => handle.miniapp)?.miniapp
  useMiniappLinkOpenStore.setState({
    view: shown
      ? {id, name: shown.name, ...(shown.iconUrl ? {iconUrl: shown.iconUrl} : {}), installing: true}
      : {id, installing: false},
  })
}

/** Show the splash for a link the person opened. */
export function beginMiniappLinkOpen(): MiniappLinkOpen {
  const handle: Handle = {
    cancelled: false,
    show: (miniapp) => {
      if (!active.has(handle)) return
      handle.miniapp = miniapp
      render()
    },
    end: () => {
      if (active.delete(handle)) render()
    },
  }
  active.add(handle)
  render()
  return handle
}

/** The person closed the splash: every link being opened stops, and the splash closes. */
export function cancelMiniappLinkOpens(): void {
  for (const handle of active) handle.cancelled = true
  active.clear()
  render()
}
