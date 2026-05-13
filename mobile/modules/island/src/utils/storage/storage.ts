// @ts-nocheck
import {createMMKV, type MMKV} from "react-native-mmkv"
import {result as Res, Result} from "typesafe-ts"

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
        throw new Error(`No value found for ${key}`)
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
