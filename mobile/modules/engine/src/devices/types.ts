import type {FirmwareEntryPoint, FirmwareProvider, FirmwareTarget} from "../ota/types"

export interface DeviceIntegration {
  readonly id: string
  readonly models: readonly string[]
  /** Host navigation policy; the device integration declares requirements, never app route paths. */
  readonly setup?: {
    readonly requiresBluetoothClassic?: boolean
    readonly checkFirmwareAfterWifi?: boolean
    readonly onboardingFlowId?: string
    readonly includeOsOnboarding?: boolean
  }
  readonly firmware?: {
    /** Rollout/source gate for new UI entry points. Recovery observation remains registered. */
    readonly isEnabled?: () => boolean
    readonly entryPoints: readonly FirmwareEntryPoint[]
    readonly createProvider: (target: FirmwareTarget) => FirmwareProvider
  }
}

/** Bundled integrations are supplied by the composition root, never imported here. */
export class DeviceIntegrationRegistry {
  private integrations = new Map<string, DeviceIntegration>()
  private models = new Map<string, string>()

  constructor(definitions: readonly DeviceIntegration[]) {
    for (const definition of definitions) {
      if (!definition.id || this.integrations.has(definition.id)) {
        throw new Error(`Duplicate or empty device integration: ${definition.id}`)
      }
      this.integrations.set(definition.id, definition)
      for (const model of definition.models) {
        if (this.models.has(model)) throw new Error(`Duplicate device model: ${model}`)
        this.models.set(model, definition.id)
      }
    }
  }

  get(id: string): DeviceIntegration | undefined {
    return this.integrations.get(id)
  }

  forModel(model: string): DeviceIntegration | undefined {
    const id = this.models.get(model)
    return id ? this.integrations.get(id) : undefined
  }
}
