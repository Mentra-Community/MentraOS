import BluetoothSdk, {type CameraFovRequest, type CameraFovResult} from "@mentra/bluetooth-sdk/internal"

export const CAMERA_FOV_OVERRIDE_TTL_MS = 300_000
export const CAMERA_FOV_OVERRIDE_REFRESH_MS = 120_000
// Legacy ASG clients restart the camera HAL for an FOV update but cannot acknowledge
// when it is usable again. The ASG cooldown is 5s; retain a small settling margin so
// miniapps cannot submit a photo against the stale camera service.
const LEGACY_CAMERA_RESTART_SETTLE_MS = 7_000

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

function isLegacyFovCompatibilityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /timed out waiting for glasses response|not available|unknown method/i.test(message)
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
  private legacyMode = false

  constructor(private readonly legacyRestartSettleMs = LEGACY_CAMERA_RESTART_SETTLE_MS) {}

  /** Report-safe FOV ownership snapshot for incident diagnostics. */
  getDiagnosticSnapshot(): Record<string, unknown> {
    return {
      owners: [...this.overrides.entries()]
        .sort(([, a], [, b]) => b.order - a.order)
        .map(([packageName, entry]) => ({
          packageName,
          effective: entry.leaseId === this.effectiveLeaseId,
          fov: entry.fov,
          roiPosition: entry.roiPosition,
        })),
      legacyMode: this.legacyMode,
    }
  }

  setOverride(packageName: string, request: CameraFovRequest): Promise<CameraFovResult> {
    return this.enqueue(async () => {
      const previous = this.overrides.get(packageName)
      const leaseId = previous?.leaseId ?? mintLeaseId()
      const order = ++this.sequence
      try {
        if (this.legacyMode) return this.setLegacyOverride(packageName, request, leaseId, order)
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
        if (!isLegacyFovCompatibilityError(error)) throw error
        console.warn("[PhoneCameraFovCoordinator] override unavailable; using legacy FOV command", error)
        const result = await this.setLegacyOverride(packageName, request, leaseId, order)
        // Only cache compatibility mode after the fallback itself succeeds. A
        // disconnect or missing native bridge must not permanently downgrade
        // future requests on a healthy/newer glasses connection.
        this.legacyMode = true
        return result
      }
    })
  }

  releaseForApp(packageName: string): Promise<void> {
    return this.enqueue(async () => {
      const removed = this.overrides.get(packageName)
      if (!removed) return
      if (removed.leaseId !== this.effectiveLeaseId) {
        this.overrides.delete(packageName)
        return
      }

      const next = [...this.overrides.entries()]
        .filter(([candidatePackage]) => candidatePackage !== packageName)
        .map(([, entry]) => entry)
        .sort((a, b) => b.order - a.order)[0]
      if (this.legacyMode) {
        if (next) {
          await this.applyLegacyFov({fov: next.fov, roiPosition: next.roiPosition})
          this.overrides.delete(packageName)
          this.effectiveLeaseId = next.leaseId
        } else {
          // Legacy commands are one-way and have no lease-release protocol.
          // Ask native to replay its unchanged persistent base setting, then
          // probe the modern override path again for the next ownership cycle.
          await BluetoothSdk.restoreLegacyCameraFov()
          await this.waitForLegacyCameraRestart()
          this.overrides.delete(packageName)
          this.clearRefresh()
          this.effectiveLeaseId = undefined
          this.legacyMode = false
        }
        return
      }
      if (next) {
        await BluetoothSdk.setCameraFovOverride({
          leaseId: next.leaseId,
          fov: next.fov,
          roiPosition: next.roiPosition,
          ttlMs: CAMERA_FOV_OVERRIDE_TTL_MS,
        })
        // Commit phone-side ownership only after ASG accepted the replacement. On failure the
        // closing app remains effective here, allowing unregister/reconnect cleanup to retry.
        this.overrides.delete(packageName)
        this.effectiveLeaseId = next.leaseId
        this.scheduleRefresh()
      } else {
        await BluetoothSdk.releaseCameraFovOverride(removed.leaseId)
        this.overrides.delete(packageName)
        this.clearRefresh()
        this.effectiveLeaseId = undefined
      }
    })
  }

  private scheduleRefresh(): void {
    if (this.legacyMode) return
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

  private async setLegacyOverride(
    packageName: string,
    request: CameraFovRequest,
    leaseId: string,
    order: number,
  ): Promise<CameraFovResult> {
    const result = await this.applyLegacyFov(request)
    this.overrides.set(packageName, {
      leaseId,
      fov: result.fov,
      roiPosition: result.roiPosition,
      order,
    })
    this.effectiveLeaseId = leaseId
    this.clearRefresh()
    return result
  }

  private async applyLegacyFov(request: CameraFovRequest): Promise<CameraFovResult> {
    const result = await BluetoothSdk.setLegacyCameraFov(request)
    await this.waitForLegacyCameraRestart()
    return result
  }

  private waitForLegacyCameraRestart(): Promise<void> {
    if (this.legacyRestartSettleMs <= 0) return Promise.resolve()
    return new Promise<void>((resolve) => setTimeout(resolve, this.legacyRestartSettleMs))
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
