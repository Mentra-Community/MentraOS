/**
 * @fileoverview SimpleStorage — phone-local AsyncStorage scoped to (userId, packageName).
 *
 * All operations round-trip to LocalMiniappRuntime, which reads/writes the
 * phone's AsyncStorage with a namespaced key format:
 *   mentraos_localstorage_{userId}_{packageName}_{key}
 *
 * Values are plain strings. Callers serialize structured data with JSON.stringify
 * themselves (matching the cloud SDK's SimpleStorage shape).
 */

import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

export class SimpleStorage {
  constructor(private readonly session: MiniappSession) {}

  async get(key: string): Promise<string | null> {
    const result = await this.session.sendRequest<{value: string | null}>({
      type: MiniappRequestType.STORAGE_GET,
      key,
    })
    return result?.value ?? null
  }

  async set(key: string, value: string): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.STORAGE_SET,
      key,
      value,
    })
  }

  async delete(key: string): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.STORAGE_DELETE,
      key,
    })
  }

  async list(): Promise<string[]> {
    const result = await this.session.sendRequest<{keys: string[]}>({
      type: MiniappRequestType.STORAGE_LIST,
    })
    return result?.keys ?? []
  }
}
