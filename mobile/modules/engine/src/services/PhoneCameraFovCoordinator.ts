import BluetoothSdk, {type CameraFovRequest, type CameraFovResult} from "@mentra/bluetooth-sdk/internal"

export const CAMERA_FOV_OVERRIDE_TTL_MS = 300_000
export const CAMERA_FOV_OVERRIDE_REFRESH_MS = 120_000

interface OverrideEntry {
  leaseId: string
  fov: number
  roiPosition: "center" | "bottom" | "top"
  order: number
}

let leaseCounter = 0

function mintLeaseId(): string {
  leaseCounter = (leaseCounter + 1) & 0xffff
  return `fov-${leaseCounter.toString(16).padStart(4, "0")}`
}

/**
 * Serializes miniapp-owned FOV/ROI overrides. The last live owner wins; releasing it applies the
 * previous owner or asks ASG to restore its persistent base. ASG refreshes are no-restart TTL
 * extensions for crash safety.
 */
export class PhoneCameraFovCoordinator {
  private readonly overrides = new Map<string, OverrideEntry>()
  private effectiveLeaseId: string | undefined
  private sequence = 0
  private queue: Promise<unknown> = Promise.resolve()
  private refreshTimer: ReturnType<typeof setTimeout> | undefined

  setOverride(packageName: string, request: CameraFovRequest): Promise<CameraFovResult> {
    return this.enqueue(async () => {
      const previous = this.overrides.get(packageName)
      const leaseId = previous?.leaseId ?? mintLeaseId()
      const order = ++this.sequence
      try {
        const result = await BluetoothSdk.setCameraFovOverride({
          ...request,
          leaseId,
          ttlMs: CAMERA_FOV_OVERRIDE_TTL_MS,
        })
        this.overrides.set(packageName, {
          leaseId,
          fov: result.fov,
          roiPosition: result.roiPosition,
          order,
        })
        this.effectiveLeaseId = leaseId
        this.scheduleRefresh()
        return result
      } catch (error) {
        if (!previous) this.overrides.delete(packageName)
        throw error
      }
    })
  }

  releaseForApp(packageName: string): Promise<void> {
    return this.enqueue(async () => {
      const removed = this.overrides.get(packageName)
      if (!removed) return
      this.overrides.delete(packageName)
      if (removed.leaseId !== this.effectiveLeaseId) return

      const next = [...this.overrides.values()].sort((a, b) => b.order - a.order)[0]
      if (next) {
        await BluetoothSdk.setCameraFovOverride({
          leaseId: next.leaseId,
          fov: next.fov,
          roiPosition: next.roiPosition,
          ttlMs: CAMERA_FOV_OVERRIDE_TTL_MS,
        })
        this.effectiveLeaseId = next.leaseId
        this.scheduleRefresh()
      } else {
        this.clearRefresh()
        this.effectiveLeaseId = undefined
        await BluetoothSdk.releaseCameraFovOverride(removed.leaseId)
      }
    })
  }

  private scheduleRefresh(): void {
    this.clearRefresh()
    const leaseId = this.effectiveLeaseId
    if (!leaseId) return
    this.refreshTimer = setTimeout(() => {
      void this.enqueue(async () => {
        if (this.effectiveLeaseId !== leaseId) return
        const entry = [...this.overrides.values()].find((candidate) => candidate.leaseId === leaseId)
        if (!entry) return
        await BluetoothSdk.setCameraFovOverride({
          leaseId,
          fov: entry.fov,
          roiPosition: entry.roiPosition,
          ttlMs: CAMERA_FOV_OVERRIDE_TTL_MS,
        })
        this.scheduleRefresh()
      }).catch((error) => console.warn("[PhoneCameraFovCoordinator] failed to refresh override", error))
    }, CAMERA_FOV_OVERRIDE_REFRESH_MS)
  }

  private clearRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

export const phoneCameraFovCoordinator = new PhoneCameraFovCoordinator()
