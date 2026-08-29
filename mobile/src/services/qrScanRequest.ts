export interface ScanQrOptions {
  title?: string
  hint?: string
}

export type ScanQrResult = {data: string} | {cancelled: true}

export interface PhoneQrScanRequest {
  id: number
  options: ScanQrOptions
}

type PendingScan = PhoneQrScanRequest & {
  snapshot: PhoneQrScanRequest
  settle: (result: ScanQrResult) => void
}

let seq = 0
let current: PendingScan | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (err) {
      console.warn("qrScanRequest listener failed", err)
    }
  }
}

export function subscribeQrScan(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getQrScanRequest(): PhoneQrScanRequest | null {
  return current?.snapshot ?? null
}

/**
 * Host seam for `session.system.scanQr`. Presents a Modal overlay via
 * `QrScanOverlay` — does not clear miniapp foreground.
 */
export function requestPhoneQrScan(options: ScanQrOptions = {}): Promise<ScanQrResult> {
  const previous = current
  const id = ++seq
  let settled = false
  const snapshot: PhoneQrScanRequest = {id, options}

  const promise = new Promise<ScanQrResult>((resolve) => {
    const settle = (result: ScanQrResult) => {
      if (settled) return
      settled = true
      if (current?.id === id) {
        current = null
        emit()
      }
      resolve(result)
    }

    current = {id, options, snapshot, settle}
    emit()
    previous?.settle({cancelled: true})
  })

  return promise
}

export function completeQrScan(result: ScanQrResult, requestId?: number): void {
  if (requestId !== undefined && current?.id !== requestId) return
  current?.settle(result)
}
