import type {ScanQrOptions, ScanQrResult} from "./bootstrap"

export class ScanQrNotConfiguredError extends Error {
  readonly code = "NOT_IMPLEMENTED"
  constructor() {
    super("QR scanning is not configured on this host. Reload the Mentra App and try again.")
    this.name = "ScanQrNotConfiguredError"
  }
}

export async function invokeScanQrSeam(
  scanQr: ((options?: ScanQrOptions) => Promise<ScanQrResult>) | undefined,
  payload: Record<string, unknown> = {},
): Promise<ScanQrResult> {
  if (!scanQr) throw new ScanQrNotConfiguredError()
  return scanQr({
    title: typeof payload.title === "string" ? payload.title : undefined,
    hint: typeof payload.hint === "string" ? payload.hint : undefined,
  })
}
