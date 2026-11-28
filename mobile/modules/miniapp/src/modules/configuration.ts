import type {MiniappSession} from "../session"
import type {UnsubscribeFn} from "./events"

/** Where a value came from: the bundle's own default, the deployment, or the person's workspace. */
export type ConfigurationSource = "shipped" | "deployment" | "workspace"

/** A file a configuration value names; its bytes are in the miniapp's blob store under `configuration/<sha256>`. */
export interface ConfigurationFile {
  name: string
  type: string
  size: number
  sha256: string
}

export class MiniappConfigurationError extends Error {
  constructor(public readonly key: string) {
    super(`Required miniapp configuration is missing: ${key}`)
    this.name = "MiniappConfigurationError"
  }
}

/**
 * Read-only configuration (managed settings) the Mentra App gives this miniapp: each key its `miniapp.json`
 * `configuration` declares, from the workspace's values, else the deployment's, else the declared `default`. An
 * appended list holds every layer's items, each with its `source`. Nothing on the phone writes it.
 */
export class ConfigurationModule {
  constructor(private readonly session: MiniappSession) {}

  /** One value, or undefined when no layer sets it. A string unless the declaration says otherwise. */
  async get<T = string>(key: string): Promise<T | undefined> {
    await this.session.waitForReady()
    const configuration = this.session._getConfiguration()
    return Object.prototype.hasOwnProperty.call(configuration, key) ? (configuration[key] as T) : undefined
  }

  /** One value, or reject with a typed error when it is absent. */
  async require<T = string>(key: string): Promise<T> {
    const value = await this.get<T>(key)
    if (value === undefined) throw new MiniappConfigurationError(key)
    return value
  }

  /** A defensive snapshot of every value. */
  async getAll(): Promise<Readonly<Record<string, unknown>>> {
    await this.session.waitForReady()
    return Object.assign(Object.create(null) as Record<string, unknown>, this.session._getConfiguration())
  }

  /** The layer a key's value came from; undefined when it has none, or on a Mentra App before managed settings. */
  async source(key: string): Promise<ConfigurationSource | undefined> {
    await this.session.waitForReady()
    return this.session._getConfigurationSources()[key]
  }

  /**
   * The blob holding a file value's bytes, or null while the Mentra App hasn't got it (it fetches a missing one again
   * when the miniapp next starts).
   */
  file(value: ConfigurationFile) {
    return this.session.blob.get(`configuration/${value.sha256}`)
  }

  /** Called with the keys whose value or source changed while the miniapp runs. */
  onChange(handler: (changed: string[]) => void): UnsubscribeFn {
    return this.session.on("configuration", handler)
  }
}
