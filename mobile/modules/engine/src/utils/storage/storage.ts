// @ts-nocheck
import {createMMKV, type MMKV} from "react-native-mmkv"
import {result as Res, Result} from "typesafe-ts"

/**
 * Thrown by load() when the key has no stored value. Callers that treat a
 * missing key as an expected state (e.g. first run) should branch on
 * `instanceof StorageValueNotFoundError` rather than matching the message.
 */
export class StorageValueNotFoundError extends Error {
  constructor(key: string) {
    super(`No value found for ${key}`)
    this.name = "StorageValueNotFoundError"
  }
}

class MMKVStorage {
  private _store?: MMKV

  private get store(): MMKV {
    if (!this._store) {
      this._store = createMMKV()
    }
    return this._store
  }

  public save(key: string, value: unknown): Result<void, Error> {
    return this.saveString(key, JSON.stringify(value))
  }

  public load<T>(key: string): Result<T, Error> {
    return Res.try(() => {
      const loadedString = this.store.getString(key) ?? ""
      if (loadedString === "") {
        throw new StorageValueNotFoundError(key)
      }
      const value = JSON.parse(loadedString) as T
      return value
    })
  }

  private saveString(key: string, value: string): Result<void, Error> {
    this.store.set(key, value)
    return Res.ok(undefined)
  }

  public getAllKeys(): string[] {
    return this.store.getAllKeys()
  }

  public removeMultiple(keys: string[]): Result<void, Error> {
    let success = true
    for (const key of keys) {
      const res = this.store.remove(key)
      if (!res) {
        success = false
      }
    }
    if (!success) {
      console.error("Failed to remove one or more keys")
      return Res.error(new Error("Failed to remove one or more keys"))
    }
    return Res.ok(undefined)
  }

  public loadSubKeys(key: string): Result<Record<string, unknown>, Error> {
    return Res.try(() => {
      // return the key value pair of any keys that start with the given key and contain a colon:
      const keys = this.store.getAllKeys()

      const subKeys = keys.filter((k) => k.startsWith(key) && k.includes(":"))

      if (subKeys.length === 0) {
        throw new Error(`No subkeys found for ${key}`)
      }

      let subKeysObject: Record<string, unknown> = {}

      for (const subKey of subKeys) {
        const res = this.load(subKey)
        if (res.is_ok()) {
          subKeysObject[subKey] = res.value
        }
      }

      return subKeysObject
    })
  }

  public remove(key: string): Result<void, Error> {
    this.store.remove(key)
    return Res.ok(undefined)
  }

  public clearAll(): Result<void, Error> {
    this.store.clearAll()
    return Res.ok(undefined)
  }
}

export const storage = new MMKVStorage()
