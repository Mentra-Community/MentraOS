/**
 * Simple Storage SDK Module for MentraOS Apps
 * Provides localStorage-like API with cloud synchronization
 *
 * Mental Model: App server RAM = source of truth, MongoDB = crash recovery backup
 * - User interactions read/write to RAM instantly
 * - Changes are debounced and batched to MongoDB (3s idle / 10s max)
 * - On disconnect, pending writes are flushed automatically
 */

import {AppSession} from ".."

/**
 * Response types for Simple Storage API
 */
interface StorageResponse {
  success: boolean
  data?: Record<string, string>
}

interface StorageOperationResponse {
  success: boolean
}

/**
 * Key-value storage with local caching and debounced cloud sync
 * Data is isolated by userId and packageName
 */
export class SimpleStorage {
  private storage: Record<string, string> | null = null
  private appSession: AppSession
  private userId: string
  private packageName: string
  private baseUrl: string

  // Debounce batching state
  private pendingWrites = new Map<string, string>()
  private debounceTimer?: NodeJS.Timeout
  private maxWaitTimer?: NodeJS.Timeout
  private firstWriteTime?: number

  // Constants
  private static readonly MAX_VALUE_SIZE = 100_000 // 100KB
  private static readonly DEBOUNCE_MS = 3_000 // 3 seconds idle
  private static readonly MAX_WAIT_MS = 10_000 // 10 seconds max

  constructor(appSession: AppSession) {
    this.appSession = appSession
    this.userId = appSession.userId
    this.packageName = appSession.getPackageName()
    this.baseUrl = this.getBaseUrl()
  }

  // Convert WebSocket URL to HTTP for API calls
  private getBaseUrl(): string {
    const serverUrl = this.appSession.getServerUrl()
    if (!serverUrl) return "http://localhost:8002"
    return serverUrl.replace(/\/app-ws$/, "").replace(/^ws/, "http")
  }

  // Generate auth headers for API requests
  private getAuthHeaders() {
    const apiKey = (this.appSession as any).config?.apiKey || "unknown-api-key"
    return {
      "Authorization": `Bearer ${this.packageName}:${apiKey}`,
      "Content-Type": "application/json",
    }
  }

  // Fetch all data from cloud and cache locally
  private async fetchStorageFromCloud(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/sdk/simple-storage/${encodeURIComponent(this.userId)}`, {
        headers: this.getAuthHeaders(),
      })

      if (response.ok) {
        const result = (await response.json()) as StorageResponse
        if (result.success && result.data) {
          this.storage = result.data
        } else {
          this.storage = {}
        }
      } else {
        console.error("Failed to fetch storage from cloud:", await response.text())
        this.storage = {}
      }
    } catch (error) {
      console.error("Error fetching storage from cloud:", error)
      this.storage = {}
    }
  }

  // Get item from cache or cloud
  public async get(key: string): Promise<string | undefined> {
    try {
      if (this.storage !== null && this.storage !== undefined) {
        return this.storage[key]
      }

      await this.fetchStorageFromCloud()
      return this.storage?.[key]
    } catch (error) {
      console.error("Error getting item:", error)
      return undefined
    }
  }

  // Set item with size validation and debounced batching
  // RAM updated immediately, MongoDB synced after 3s idle or 10s max
  public async set(key: string, value: string): Promise<void> {
    try {
      // Validate value size
      if (value.length > SimpleStorage.MAX_VALUE_SIZE) {
        throw new Error(
          `SimpleStorage value exceeds 100KB limit (${value.length} bytes). ` +
            `For large files, use your own S3 bucket storage.`,
        )
      }

      if (this.storage === null || this.storage === undefined) {
        await this.fetchStorageFromCloud()
      }

      // Optimistic update - RAM is source of truth (instant)
      if (this.storage) {
        this.storage[key] = value
      }

      // Add to pending batch for MongoDB persistence
      this.pendingWrites.set(key, value)

      // Schedule debounced flush
      this.scheduleFlush()
    } catch (error) {
      console.error("Error setting item:", error)
      throw error
    }
  }

  /**
   * Schedule flush with debounce (3s idle) and max wait (10s)
   */
  private scheduleFlush(): void {
    // Track first write time for max wait
    if (!this.firstWriteTime) {
      this.firstWriteTime = Date.now()
    }

    // Clear existing debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    // Calculate time until max wait
    const elapsedMs = Date.now() - this.firstWriteTime
    const remainingMaxWaitMs = SimpleStorage.MAX_WAIT_MS - elapsedMs

    // If we've hit max wait, flush immediately
    if (remainingMaxWaitMs <= 0) {
      this.flush().catch((err) => {
        console.error("Error flushing SimpleStorage:", err)
      })
      return
    }

    // Set debounce timer (3s idle)
    this.debounceTimer = setTimeout(
      () => {
        this.flush().catch((err) => {
          console.error("Error flushing SimpleStorage:", err)
        })
      },
      Math.min(SimpleStorage.DEBOUNCE_MS, remainingMaxWaitMs),
    )

    // Set max wait timer if not already set
    if (!this.maxWaitTimer && remainingMaxWaitMs > 0) {
      this.maxWaitTimer = setTimeout(() => {
        this.flush().catch((err) => {
          console.error("Error flushing SimpleStorage (max wait):", err)
        })
      }, remainingMaxWaitMs)
    }
  }

  /**
   * Flush pending writes immediately
   * Called by: debounce timeout, max wait timeout, disconnect, or explicit flush()
   */
  public async flush(): Promise<void> {
    if (this.pendingWrites.size === 0) return

    // Clear all timers
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
    }
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer)
      this.maxWaitTimer = undefined
    }
    this.firstWriteTime = undefined

    const batch = Object.fromEntries(this.pendingWrites)
    this.pendingWrites.clear()

    try {
      // Persist to MongoDB (backup for crash recovery)
      const response = await fetch(`${this.baseUrl}/api/sdk/simple-storage/${encodeURIComponent(this.userId)}`, {
        method: "PUT",
        headers: this.getAuthHeaders(),
        body: JSON.stringify({data: batch}),
      })

      if (!response.ok) {
        const error = await response.text()
        console.error("Failed to persist SimpleStorage to MongoDB:", error)

        // Re-throw with helpful message
        if (response.status === 413) {
          throw new Error("SimpleStorage total size exceeds 1MB limit. Delete unused keys.")
        }
        if (response.status === 429) {
          throw new Error("SimpleStorage rate limit exceeded.")
        }
        throw new Error(`SimpleStorage flush failed: ${error}`)
      }
    } catch (error) {
      console.error("Error flushing SimpleStorage:", error)
      throw error
    }
  }

  // Delete item from cache and debounced sync to cloud
  public async delete(key: string): Promise<boolean> {
    try {
      if (this.storage === null || this.storage === undefined) {
        await this.fetchStorageFromCloud()
      }

      // Remove from cache (RAM = source of truth)
      if (this.storage) {
        delete this.storage[key]
      }

      // Remove from pending writes if exists
      this.pendingWrites.delete(key)

      // For deletes, we flush immediately to ensure consistency
      // (could batch this too, but deletes are rare)
      const response = await fetch(
        `${this.baseUrl}/api/sdk/simple-storage/${encodeURIComponent(this.userId)}/${encodeURIComponent(key)}`,
        {
          method: "DELETE",
          headers: this.getAuthHeaders(),
        },
      )

      if (response.ok) {
        const result = (await response.json()) as StorageOperationResponse
        return result.success
      } else {
        console.error("Failed to delete item from cloud:", await response.text())
        return false
      }
    } catch (error) {
      console.error("Error deleting item:", error)
      return false
    }
  }

  // Clear all data from cache and cloud
  public async clear(): Promise<boolean> {
    try {
      this.storage = {}

      const response = await fetch(`${this.baseUrl}/api/sdk/simple-storage/${encodeURIComponent(this.userId)}`, {
        method: "DELETE",
        headers: this.getAuthHeaders(),
      })

      if (response.ok) {
        const result = (await response.json()) as StorageOperationResponse
        return result.success
      } else {
        console.error("Failed to clear storage from cloud:", await response.text())
        return false
      }
    } catch (error) {
      console.error("Error clearing storage:", error)
      return false
    }
  }

  // Get all storage keys
  public async keys(): Promise<string[]> {
    try {
      if (this.storage === null || this.storage === undefined) {
        await this.fetchStorageFromCloud()
      }
      return Object.keys(this.storage || {})
    } catch (error) {
      console.error("Error getting keys:", error)
      return []
    }
  }

  // Get number of stored items
  public async size(): Promise<number> {
    try {
      if (this.storage === null || this.storage === undefined) {
        await this.fetchStorageFromCloud()
      }
      return Object.keys(this.storage || {}).length
    } catch (error) {
      console.error("Error getting storage size:", error)
      return 0
    }
  }

  // Check if key exists
  public async hasKey(key: string): Promise<boolean> {
    try {
      if (this.storage === null || this.storage === undefined) {
        await this.fetchStorageFromCloud()
      }
      return key in (this.storage || {})
    } catch (error) {
      console.error("Error checking key:", error)
      return false
    }
  }

  // Get copy of all stored data
  public async getAllData(): Promise<Record<string, string>> {
    try {
      if (this.storage === null || this.storage === undefined) {
        await this.fetchStorageFromCloud()
      }
      return {...(this.storage || {})}
    } catch (error) {
      console.error("Error getting all data:", error)
      return {}
    }
  }

  // Set multiple items at once with validation
  public async setMultiple(data: Record<string, string>): Promise<void> {
    try {
      // Validate all values first
      for (const [key, value] of Object.entries(data)) {
        if (value.length > SimpleStorage.MAX_VALUE_SIZE) {
          throw new Error(`SimpleStorage value for key "${key}" exceeds 100KB limit (${value.length} bytes)`)
        }
      }

      if (this.storage === null || this.storage === undefined) {
        await this.fetchStorageFromCloud()
      }

      // Update cache (RAM = source of truth)
      if (this.storage) {
        Object.assign(this.storage, data)
      }

      // Add all to pending batch
      for (const [key, value] of Object.entries(data)) {
        this.pendingWrites.set(key, value)
      }

      // Schedule debounced flush
      this.scheduleFlush()
    } catch (error) {
      console.error("Error setting multiple items:", error)
      throw error
    }
  }
}
