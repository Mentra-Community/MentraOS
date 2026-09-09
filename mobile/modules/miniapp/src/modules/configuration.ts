import type {MiniappSession} from "../session"

export class MiniappConfigurationError extends Error {
  constructor(public readonly key: string) {
    super(`Required miniapp configuration is missing: ${key}`)
    this.name = "MiniappConfigurationError"
  }
}

/** Read-only package configuration supplied by the Mentra App host. */
export class ConfigurationModule {
  constructor(private readonly session: MiniappSession) {}

  /** Return one configured value, or undefined when the host supplied no override. */
  async get(key: string): Promise<string | undefined> {
    await this.session.waitForReady()
    const configuration = this.session._getConfiguration()
    return Object.prototype.hasOwnProperty.call(configuration, key) ? configuration[key] : undefined
  }

  /** Return one configured value or reject with a typed error when it is absent. */
  async require(key: string): Promise<string> {
    const value = await this.get(key)
    if (value === undefined) throw new MiniappConfigurationError(key)
    return value
  }

  /** Return a defensive snapshot of every value supplied to this package. */
  async getAll(): Promise<Readonly<Record<string, string>>> {
    await this.session.waitForReady()
    return Object.assign(Object.create(null) as Record<string, string>, this.session._getConfiguration())
  }
}
