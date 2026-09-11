import {useEffect, useState} from "react"

import type {Channels} from "../../shared/channels"

/**
 * useChannel — subscribe to a background-pushed channel and surface the latest
 * payload as React state.
 *
 * The WebView's `mentra` global is a fire-and-forget bus; components that want
 * to render what background pushed use this hook. It subscribes on mount, holds
 * the latest payload in state, and unsubscribes on unmount. Background pushes a
 * `captions:snapshot` on session.ui.onOpen which seeds the per-field channels,
 * so the "no data" window is typically a frame or two.
 */
export function useChannel<C extends keyof Channels & string>(
  channel: C,
  initial?: Channels[C],
): Channels[C] | undefined {
  const [value, setValue] = useState<Channels[C] | undefined>(initial)
  useEffect(() => {
    return (mentra.on as (c: string, cb: (p: unknown) => void) => () => void)(
      channel,
      (payload) => setValue(payload as Channels[C]),
    )
  }, [channel])
  return value
}
