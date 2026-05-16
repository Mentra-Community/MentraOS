import {useEffect, useState} from "react"

import type {Channels} from "../../shared/channels"

/**
 * useChannel — subscribe to a background-pushed channel and get the
 * latest payload as React state.
 *
 * The WebView's `mentra` global doesn't expose state; it's a
 * fire-and-forget bus. Components that want to *render* what background
 * pushed use this hook — it subscribes once on mount, holds the latest
 * payload in React state, and unsubscribes on unmount.
 *
 * On first render the hook returns `initial` (defaults to undefined).
 * Background usually pushes a `captions:snapshot` on `session.ui.onOpen`
 * which seeds all the per-field channels, so the "no data" window is
 * typically a frame or two.
 */
export function useChannel<C extends keyof Channels & string>(
  channel: C,
  initial?: Channels[C],
): Channels[C] | undefined {
  const [value, setValue] = useState<Channels[C] | undefined>(initial)
  useEffect(() => {
    return mentra.on(channel, (payload) => setValue(payload as Channels[C]))
  }, [channel])
  return value
}
