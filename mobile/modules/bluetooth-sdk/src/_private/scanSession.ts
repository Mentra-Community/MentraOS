import type {Device, DeviceModel, ScanDiagnostic} from "../BluetoothSdk.types"

interface ScanTransport {
  start: (model: DeviceModel) => Promise<void>
  stop: () => Promise<void>
  subscribe: (onResults: (devices: Device[]) => void) => () => void
  getResults: () => Promise<Device[]>
  getDiagnostic?: () => Promise<ScanDiagnostic | null>
}

interface ScanSessionOptions {
  model: DeviceModel
  timeoutMs: number
  onResults?: (devices: Device[]) => void
  onDiagnostic?: (diagnostic: ScanDiagnostic) => void
}

/** A scan has one completion; optional diagnostics cannot turn it into a failure. */
export function createScanSession(transport: ScanTransport, options: ScanSessionOptions) {
  let cancel: () => Promise<void> = async () => {}
  const result = new Promise<Device[]>((resolve, reject) => {
    let latestResults: Device[] = []
    let ending = false
    let cancelled = false
    let startTask: Promise<void> | undefined
    let stopTask: Promise<void> = Promise.resolve()
    let removeListener = () => {}
    let timeout: ReturnType<typeof setTimeout> | undefined

    const emit = (devices: Device[]) => {
      if (ending) return
      latestResults = devices
      options.onResults?.([...devices])
    }

    const finish = async (error?: unknown) => {
      if (ending) return
      ending = true
      clearTimeout(timeout)
      removeListener()
      stopTask = (async () => {
        try {
          await startTask
          await transport.stop()
        } catch {
          // Failed starts and stops do not change the completion contract.
        }
      })()
      await stopTask
      if (error !== undefined) {
        reject(error)
        return
      }
      // Query only at natural, empty completion. A cancellation during the
      // native lookup must also suppress the pending advisory.
      if (!cancelled && latestResults.length === 0 && options.onDiagnostic && transport.getDiagnostic) {
        try {
          const diagnostic = await transport.getDiagnostic()
          if (!cancelled && diagnostic) options.onDiagnostic(diagnostic)
        } catch {
          // Optional platform access or advisory handling cannot fail a scan.
        }
      }
      resolve([...latestResults])
    }

    cancel = () => {
      cancelled = true
      void finish()
      return stopTask
    }

    void (async () => {
      try {
        removeListener = transport.subscribe(emit)
        emit([])
        timeout = setTimeout(() => void finish(), options.timeoutMs)
        startTask = Promise.resolve().then(() => transport.start(options.model))
        await startTask
        if (ending) return
        emit(await transport.getResults())
      } catch (error) {
        void finish(error)
      }
    })()
  })
  return {result, cancel: () => cancel()}
}
