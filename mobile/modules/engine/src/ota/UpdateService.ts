import {DeviceIntegrationRegistry} from "../devices/types"
import {
  FirmwareUpdateError,
  type FirmwareActionRequest,
  type FirmwareActionResult,
  type FirmwareOpenOptions,
  type FirmwareProvider,
  type FirmwareSnapshot,
  type FirmwareTarget,
} from "./types"

function targetKey(target: FirmwareTarget): string {
  return JSON.stringify([target.integrationId, target.deviceId])
}

/** One active glasses update. Observation never acquires an execution reservation. */
export class FirmwareUpdateService {
  private providers = new Map<string, FirmwareProvider>()
  private commands = new Map<string, Promise<FirmwareActionResult>>()
  private requests = new Map<string, FirmwareActionRequest>()
  private openings = new Map<string, Promise<FirmwareProvider>>()
  private lifecycleGeneration = 0

  constructor(private readonly registry: DeviceIntegrationRegistry) {}

  provider(target: FirmwareTarget): FirmwareProvider {
    if (!target.deviceId) throw new FirmwareUpdateError("unsupported", "A native device identity is required")
    const key = targetKey(target)
    const existing = this.providers.get(key)
    if (existing) return existing
    const definition = this.registry.get(target.integrationId)
    if (!definition?.firmware) throw new FirmwareUpdateError("unsupported", "This device has no firmware updater")
    const provider = definition.firmware.createProvider({...target})
    if (targetKey(provider.target) !== key) {
      provider.dispose()
      throw new FirmwareUpdateError("invalid_provider", "The updater is bound to a different device")
    }
    this.providers.set(key, provider)
    return provider
  }

  async open(target: FirmwareTarget, options: FirmwareOpenOptions): Promise<FirmwareProvider> {
    const definition = this.registry.get(target.integrationId)
    if (!definition?.firmware?.entryPoints.includes(options.entryPoint)) {
      throw new FirmwareUpdateError("unsupported", "This update entry point is not supported")
    }
    this.assertAvailable(target)
    const key = targetKey(target)
    const pending = this.openings.get(key)
    if (pending) return pending
    // Selecting another device explicitly retires safely idle flows, including their native owner tokens.
    for (const [other, existing] of this.providers) {
      if (other !== key && !existing.snapshot().active && existing.snapshot().safeToRelease) {
        existing.dispose()
        this.providers.delete(other)
      }
    }
    const provider = this.provider(target)
    const generation = this.lifecycleGeneration
    const opening = Promise.resolve().then(async () => {
      if (generation !== this.lifecycleGeneration)
        throw new FirmwareUpdateError("action_unavailable", "The host runtime stopped")
      await provider.open(options)
      return provider
    })
    this.openings.set(key, opening)
    try {
      return await opening
    } finally {
      if (this.openings.get(key) === opening) this.openings.delete(key)
    }
  }

  snapshot(target: FirmwareTarget): FirmwareSnapshot {
    return this.provider(target).snapshot()
  }

  subscribe(target: FirmwareTarget, listener: (snapshot: FirmwareSnapshot) => void): () => void {
    return this.provider(target).subscribe(listener)
  }

  async perform(target: FirmwareTarget, request: FirmwareActionRequest): Promise<FirmwareActionResult> {
    const key = targetKey(target)
    const provider = this.provider(target)
    const snapshot = provider.snapshot()
    const pendingRequest = this.requests.get(key)
    if (
      request.action === "install" &&
      pendingRequest?.action === "install" &&
      request.offerId === pendingRequest.offerId
    ) {
      return this.commands.get(key)!
    }
    // An already accepted Start adopts the existing flow, even after the Install button disappears.
    if (request.action === "install" && request.offerId && snapshot.active && request.offerId === snapshot.offer?.id) {
      return this.commands.get(key) ?? Promise.resolve({kind: "none"})
    }
    try {
      this.assertAvailable(target)
      if (this.commands.has(key) || this.openings.has(key))
        throw new FirmwareUpdateError("busy", "An update command is already pending")
      const action = snapshot.presentation.actions.find((candidate) => candidate.id === request.action)
      if (!action || action.disabled)
        throw new FirmwareUpdateError("action_unavailable", "This update action is unavailable")
      if (request.action === "install" && (!request.offerId || request.offerId !== snapshot.offer?.id)) {
        throw new FirmwareUpdateError("stale_offer", "The update offer has changed; check again before installing")
      }
    } catch (error) {
      return Promise.reject(error)
    }
    // Reserve synchronously, before provider code can await or publish a reentrant snapshot.
    const generation = this.lifecycleGeneration
    const clearCommand = () => {
      if (this.commands.get(key) === command) {
        this.commands.delete(key)
        this.requests.delete(key)
      }
    }
    const command = Promise.resolve()
      .then(() => {
        if (generation !== this.lifecycleGeneration)
          throw new FirmwareUpdateError("action_unavailable", "The host runtime stopped")
        return provider.perform(request)
      })
      .then(
        (result) => {
          clearCommand()
          if (result.kind === "finished" && provider.snapshot().safeToRelease) this.release(target)
          return result
        },
        (error) => {
          clearCommand()
          throw error
        },
      )
    this.commands.set(key, command)
    this.requests.set(key, {...request})
    return command
  }

  assertSafeToRelease(): void {
    if (
      this.commands.size ||
      this.openings.size ||
      [...this.providers.values()].some((provider) => !provider.snapshot().safeToRelease)
    ) {
      throw new FirmwareUpdateError("busy", "The glasses are updating; wait before disconnecting or resetting them")
    }
  }

  suspendNewWork(): void {
    this.lifecycleGeneration++
    for (const provider of this.providers.values()) provider.suspendNewWork()
  }

  diagnosticSnapshot() {
    // Offers can contain manifest URLs, and provider details are untrusted for reporting.
    return [...this.providers.values()].map((provider) => {
      const s = provider.snapshot()
      return {
        target: s.target,
        flowId: s.flowId,
        attemptId: s.attemptId,
        nativeSessionId: s.nativeSessionId,
        revision: s.revision,
        phase: s.phase,
        active: s.active,
        safeToRelease: s.safeToRelease,
        observedVersion: s.offer?.observedVersion ?? null,
        targetVersion: s.offer?.targetVersion ?? null,
        errorCode: s.error?.code ?? null,
        deviceErrorCode: s.error?.deviceCode ?? null,
      }
    })
  }

  /** Explicitly release a safely finished flow; view unsubscription never calls this. */
  release(target: FirmwareTarget): void {
    const key = targetKey(target)
    const provider = this.providers.get(key)
    if (!provider) return
    if (this.commands.has(key) || this.openings.has(key) || !provider.snapshot().safeToRelease) {
      throw new FirmwareUpdateError("busy", "This update still owns the device")
    }
    provider.dispose()
    this.providers.delete(key)
  }

  private assertAvailable(target: FirmwareTarget): void {
    const key = targetKey(target)
    const busyCommand = [...this.commands.keys(), ...this.openings.keys()].some((other) => other !== key)
    const busyProvider = [...this.providers.entries()].some(
      ([other, provider]) => other !== key && (provider.snapshot().active || !provider.snapshot().safeToRelease),
    )
    if (busyCommand || busyProvider) throw new FirmwareUpdateError("busy", "Another device update is active")
  }
}
