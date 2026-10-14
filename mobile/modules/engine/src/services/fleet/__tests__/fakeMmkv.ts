/**
 * A fake `react-native-mmkv` for bun. Every instance id gets its own map, so a test can prove which instance
 * something lives in and what the default instance's `clearAll()` (the app's logout) leaves alone.
 */
export class FakeMmkv {
  readonly values = new Map<string, string>()

  getString(key: string): string | undefined {
    return this.values.get(key)
  }

  set(key: string, value: string | number | boolean): void {
    this.values.set(key, String(value))
  }

  remove(key: string): boolean {
    return this.values.delete(key)
  }

  contains(key: string): boolean {
    return this.values.has(key)
  }

  getAllKeys(): string[] {
    return [...this.values.keys()]
  }

  clearAll(): void {
    this.values.clear()
  }
}

export const DEFAULT_MMKV_ID = "mmkv.default"
export const mmkvInstances = new Map<string, FakeMmkv>()
export const createMMKVCalls: Array<{id: string}> = []

export function fakeCreateMMKV(config?: {id?: string}): FakeMmkv {
  const id = config?.id ?? DEFAULT_MMKV_ID
  createMMKVCalls.push({id})
  let instance = mmkvInstances.get(id)
  if (!instance) {
    instance = new FakeMmkv()
    mmkvInstances.set(id, instance)
  }
  return instance
}

/**
 * Empties every instance and forgets the recorded calls. Instances keep their identity: code under test caches
 * the instance it opened, and must keep seeing the one this module hands out.
 */
export function resetFakeMmkv(): void {
  for (const instance of mmkvInstances.values()) instance.clearAll()
  createMMKVCalls.length = 0
}
