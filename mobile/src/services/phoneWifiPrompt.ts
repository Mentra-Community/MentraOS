export interface PhoneWifiPrompt {
  id: number
  title: string
  message: string
  actionLabel: string
}

let nextId = 0
let current: {snapshot: PhoneWifiPrompt; resolve: (confirmed: boolean) => void} | null = null
const listeners = new Set<() => void>()
let hosts = 0

export function registerPhoneWifiPromptHost(): () => void {
  hosts++
  return () => {
    hosts--
    if (hosts === 0) completePhoneWifiPrompt(false)
  }
}

export const getPhoneWifiPrompt = () => current?.snapshot ?? null
export function subscribePhoneWifiPrompt(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** An owned overlay, independent of the replaceable global AlertUtils dialog. */
export function requestPhoneWifiPrompt(options: Omit<PhoneWifiPrompt, "id">): Promise<boolean> {
  if (hosts === 0) return Promise.resolve(false)
  const previous = current
  const promise = new Promise<boolean>((resolve) => {
    current = {snapshot: {...options, id: ++nextId}, resolve}
  })
  previous?.resolve(false)
  listeners.forEach((listener) => listener())
  return promise
}

/** Stale button callbacks cannot dismiss a replacement prompt. Also used on host unmount. */
export function completePhoneWifiPrompt(confirmed: boolean, id = current?.snapshot.id): void {
  if (!current || current.snapshot.id !== id) return
  const pending = current
  current = null
  listeners.forEach((listener) => listener())
  pending.resolve(confirmed)
}
