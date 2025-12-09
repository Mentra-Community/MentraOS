# SimpleStorage Limits & Rate Protection - Architecture

## Key Concept: RAM-Backed Persistence

**Mental model**: App server RAM = source of truth, MongoDB = crash recovery backup

User interactions read/write to RAM instantly. MongoDB just needs eventual persistence for app restarts. This allows aggressive debounce batching (3s idle / 10s max) without impacting user experience.

## Current System

### Data Flow

```
SDK (App Server)                 Cloud API                    MongoDB
     |                               |                            |
     | set(key, val)                 |                            |
     |----------------------------->|                            |
     |  PUT /simple-storage/:email/:key                          |
     |                              |                            |
     |                              | findOneAndUpdate           |
     |                              |--------------------------->|
     |                              |     $set: {data.key: val}  |
     |                              |                            |
     |                              |<---------------------------|
     |<-----------------------------|                            |
     |  200 OK                      |                            |
```

### Current Code Paths

**SDK: `cloud/packages/sdk/src/app/session/modules/simple-storage.ts`**

```typescript
public async set(key: string, value: string): Promise<void> {
  // Update cache immediately (RAM = source of truth)
  if (this.storage) {
    this.storage[key] = value;
  }

  // Sync to cloud immediately (no batching, no validation)
  const response = await fetch(
    `${baseUrl}/api/sdk/simple-storage/${email}/${key}`,
    { method: 'PUT', body: JSON.stringify({ value }) }
  );
}
```

**Cloud API: `cloud/packages/cloud/src/api/sdk/simple-storage.api.ts`**

```typescript
async function setKeyHandler(req: Request, res: Response) {
  const {value} = req.body
  // No validation here
  await SimpleStorageService.setKey(email, packageName, key, value)
  return res.status(200).json({success: true})
}
```

**Cloud Service: `cloud/packages/cloud/src/services/sdk/simple-storage.service.ts`**

```typescript
export async function setKey(email: string, packageName: string, key: string, value: string): Promise<void> {
  // No size checks
  await SimpleStorage.findOneAndUpdate({email, packageName}, {$set: {[`data.${key}`]: value}}, {upsert: true}).exec()
}
```

**MongoDB Model: `cloud/packages/cloud/src/models/simple-storage.model.ts`**

```typescript
const simpleStorageSchema = new mongoose.Schema({
  email: String,
  packageName: String,
  data: {
    type: Object, // Record<string, string>
    of: String,
    default: () => ({}),
  },
})
```

### Problems with Current System

1. **No validation** - accepts any size value
2. **No batching** - every `set()` = immediate network call (wasteful for RAM-backed persistence)
3. **No total size tracking** - could exceed MongoDB 16MB doc limit
4. **Poor error messages** - just "Failed to set key"
5. **No flush on disconnect** - pending writes lost on app shutdown

## Proposed System

### New Data Flow with Debounce Batching

```
SDK (App Server)             Cloud API                    MongoDB
 |                               |                            |
 | set("a", "1") t=0s            |                            |
 |  ✓ Check 100KB               |                            |
 |  → RAM update (instant)      |                            |
 |  → Add to pending batch      |                            |
 |  → Start 3s debounce timer   |                            |
 |  → Start 10s max timer       |                            |
 |                              |                            |
 | set("b", "2") t=2s           |                            |
 |  ✓ Check 100KB               |                            |
 |  → RAM update (instant)      |                            |
 |  → Add to pending batch      |                            |
 |  → Reset 3s debounce         |                            |
 |  → Keep 10s max timer        |                            |
 |                              |                            |
 | set("c", "3") t=5s           |                            |
 |  ✓ Check 100KB               |                            |
 |  → RAM update (instant)      |                            |
 |  → Add to pending batch      |                            |
 |  → Reset 3s debounce         |                            |
 |                              |                            |
 | [3s idle OR 10s max]         |                            |
 | t=8s (3s after last write)   |                            |
 |----------------------------->|                            |
 |  PUT /simple-storage/:email  |                            |
 |  { data: {a:"1",b:"2",c:"3"}}|                            |
 |                              |                            |
 |                              | ✓ Value sizes (<100KB)     |
 |                              | ✓ Total size (<1MB)        |
 |                              |                            |
 |                              | updateMany()               |
 |                              |--------------------------->|
 |                              |                            |
 |                              |<---------------------------|
 |<-----------------------------|                            |
 |  200 OK                      |                            |
 |                              |                            |
 | disconnect()                 |                            |
 |  → flush() pending writes    |                            |
 |----------------------------->|                            |
```

## Implementation Details

### 1. SDK Validation Layer

**File**: `cloud/packages/sdk/src/app/session/modules/simple-storage.ts`

```typescript
export class SimpleStorage {
  private storage: Record<string, string> | null = null
  private pendingWrites = new Map<string, string>()
  private debounceTimer?: NodeJS.Timeout
  private maxWaitTimer?: NodeJS.Timeout
  private firstWriteTime?: number

  // Constants
  private static readonly MAX_VALUE_SIZE = 100_000 // 100KB
  private static readonly DEBOUNCE_MS = 3_000 // 3 seconds idle
  private static readonly MAX_WAIT_MS = 10_000 // 10 seconds max

  /**
   * Set value with size validation and debounced batching
   * RAM updated immediately, MongoDB synced after 3s idle or 10s max
   */
  public async set(key: string, value: string): Promise<void> {
    // Validate value size
    if (value.length > SimpleStorage.MAX_VALUE_SIZE) {
      throw new Error(
        `SimpleStorage value exceeds 100KB limit (${value.length} bytes). ` +
          `For large files, use your own S3 bucket storage.`,
      )
    }

    // Ensure storage is loaded
    if (this.storage === null) {
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
   * Called by: debounce timeout, max wait timeout, or explicit flush()
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
    }
  }

  /**
   * setMultiple now validates each value
   */
  public async setMultiple(data: Record<string, string>): Promise<void> {
    // Validate all values first
    for (const [key, value] of Object.entries(data)) {
      if (value.length > SimpleStorage.MAX_VALUE_SIZE) {
        throw new Error(`SimpleStorage value for key "${key}" exceeds 100KB limit (${value.length} bytes)`)
      }
    }

    // Original implementation (no batching needed - already bulk)
    if (this.storage === null) {
      await this.fetchStorageFromCloud()
    }

    if (this.storage) {
      Object.assign(this.storage, data)
    }

    const response = await fetch(`${this.baseUrl}/api/sdk/simple-storage/${encodeURIComponent(this.userId)}`, {
      method: "PUT",
      headers: this.getAuthHeaders(),
      body: JSON.stringify({data}),
    })

    if (!response.ok) {
      const error = await response.text()
      console.error("Failed to upsert multiple items:", error)
      throw new Error(`SimpleStorage setMultiple failed: ${error}`)
    }
  }
}
```

### 2. Cloud Rate Limiting (Safety Net)

**New File**: `cloud/packages/cloud/src/api/middleware/rate-limit.middleware.ts`

With 3s/10s debouncing, rate limiting is less critical but still useful as backup protection against bugs/abuse.

```typescript
import rateLimit from "express-rate-limit"
import {Request, Response} from "express"

/**
 * Rate limiter for SimpleStorage endpoints
 * Backup safety net - debouncing should prevent most issues
 * Keyed by (email, packageName) from SDK auth
 */
export const simpleStorageRateLimit = rateLimit({
  windowMs: 60_000, // 1 minute
  max: 100, // 100 requests per minute (generous with debouncing)

  // Key by user+package combo
  keyGenerator: (req: Request) => {
    const email = String(req.params.email || "").toLowerCase()
    const packageName = req.sdk?.packageName || "unknown"
    return `${email}:${packageName}`
  },

  // Return JSON error
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      error: "Rate limit exceeded: 100 requests/min max for SimpleStorage",
      retryAfter: 60,
    })
  },

  standardHeaders: true,
  legacyHeaders: false,
})
```

### 3. Cloud Validation Layer

**Updated File**: `cloud/packages/cloud/src/services/sdk/simple-storage.service.ts`

```typescript
const MAX_VALUE_SIZE = 100_000 // 100KB
const MAX_TOTAL_SIZE = 1_000_000 // 1MB

/**
 * Calculate total storage size for a document
 */
function calculateStorageSize(data: Record<string, string>): number {
  return Object.values(data).reduce((sum, value) => sum + value.length, 0)
}

/**
 * Validate value size
 */
function validateValueSize(value: string, key?: string): void {
  if (value.length > MAX_VALUE_SIZE) {
    const keyMsg = key ? ` for key "${key}"` : ""
    throw new Error(
      `Value${keyMsg} exceeds 100KB limit (${value.length} bytes). ` +
        `Use your own S3 bucket storage for large files.`,
    )
  }
}

/**
 * Set single key with validation
 */
export async function setKey(email: string, packageName: string, key: string, value: string): Promise<void> {
  // Validate value size
  validateValueSize(value, key)

  // Get current document
  const doc = await SimpleStorage.findOne({email, packageName}).exec()
  const currentData = (doc?.data as Record<string, string>) || {}

  // Calculate new total size
  const currentSize = calculateStorageSize(currentData)
  const oldValueSize = currentData[key]?.length || 0
  const newTotalSize = currentSize - oldValueSize + value.length

  if (newTotalSize > MAX_TOTAL_SIZE) {
    throw new Error(
      `Total storage exceeds 1MB limit ` +
        `(current: ${currentSize}, new: ${newTotalSize}). ` +
        `Delete unused keys or use S3 storage.`,
    )
  }

  // Update
  await SimpleStorage.findOneAndUpdate(
    {email, packageName},
    {$set: {[`data.${key}`]: value}},
    {upsert: true, new: true},
  ).exec()
}

/**
 * Update many keys with validation
 */
export async function updateMany(email: string, packageName: string, data: Record<string, string>): Promise<void> {
  if (Object.keys(data).length === 0) return

  // Validate each value size
  for (const [key, value] of Object.entries(data)) {
    validateValueSize(value, key)
  }

  // Get current document
  const doc = await SimpleStorage.findOne({email, packageName}).exec()
  const currentData = (doc?.data as Record<string, string>) || {}

  // Calculate new total size
  const newData = {...currentData, ...data}
  const newTotalSize = calculateStorageSize(newData)

  if (newTotalSize > MAX_TOTAL_SIZE) {
    const currentSize = calculateStorageSize(currentData)
    const addedSize = calculateStorageSize(data)
    throw new Error(
      `Total storage would exceed 1MB limit ` +
        `(current: ${currentSize}, adding: ${addedSize}, total: ${newTotalSize}). ` +
        `Delete unused keys or use S3 storage.`,
    )
  }

  // Update
  const setPayload: Record<string, string> = {}
  for (const [key, value] of Object.entries(data)) {
    setPayload[`data.${key}`] = value
  }

  await SimpleStorage.findOneAndUpdate({email, packageName}, {$set: setPayload}, {upsert: true, new: true}).exec()
}
```

### 4. Cloud API Error Handling

**Updated File**: `cloud/packages/cloud/src/api/sdk/simple-storage.api.ts`

```typescript
import {simpleStorageRateLimit} from "../middleware/rate-limit.middleware"

// Apply rate limiting to all routes
router.use(simpleStorageRateLimit)

async function setKeyHandler(req: Request, res: Response) {
  try {
    if (!req.sdk) {
      return res.status(401).json({error: "Unauthorized"})
    }

    const email = String(req.params.email || "").toLowerCase()
    const key = String(req.params.key || "")
    const packageName = req.sdk.packageName
    const {value} = req.body || {}

    if (!email || !key) {
      return res.status(400).json({error: "Missing email or key parameter"})
    }

    if (typeof value !== "string") {
      return res.status(400).json({
        error: "Invalid body: expected { value: string }",
      })
    }

    await SimpleStorageService.setKey(email, packageName, key, value)
    return res.status(200).json({
      success: true,
      message: `Key "${key}" set`,
    })
  } catch (error) {
    console.error("PUT /api/sdk/simple-storage/:email/:key error:", error)

    // Return specific error messages
    const message = error instanceof Error ? error.message : "Failed to set key"

    if (message.includes("exceeds 100KB limit")) {
      return res.status(400).json({error: message})
    }
    if (message.includes("exceeds 1MB limit")) {
      return res.status(413).json({error: message})
    }

    return res.status(500).json({error: message})
  }
}

async function updateManyHandler(req: Request, res: Response) {
  try {
    if (!req.sdk) {
      return res.status(401).json({error: "Unauthorized"})
    }

    const email = String(req.params.email || "").toLowerCase()
    const packageName = req.sdk.packageName
    const {data} = req.body || {}

    if (!email) {
      return res.status(400).json({error: "Missing email parameter"})
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return res.status(400).json({
        error: "Invalid body: expected { data: Record<string,string> }",
      })
    }

    // Validate all values are strings
    const invalid = Object.entries(data).find(([, v]) => typeof v !== "string")
    if (invalid) {
      return res.status(400).json({
        error: "All values must be strings",
        detail: `Invalid value for key "${invalid[0]}"`,
      })
    }

    await SimpleStorageService.updateMany(email, packageName, data as Record<string, string>)

    return res.status(200).json({
      success: true,
      message: "Storage updated",
    })
  } catch (error) {
    console.error("PUT /api/sdk/simple-storage/:email error:", error)

    const message = error instanceof Error ? error.message : "Failed to update storage"

    if (message.includes("exceeds 100KB limit")) {
      return res.status(400).json({error: message})
    }
    if (message.includes("exceeds 1MB limit")) {
      return res.status(413).json({error: message})
    }

    return res.status(500).json({error: message})
  }
}
```

## AppSession Integration: Flush on Disconnect

**File**: `cloud/packages/sdk/src/app/session/index.ts`

```typescript
export class AppSession {
  public simpleStorage: SimpleStorage

  /**
   * Disconnect with graceful flush
   */
  public async disconnect(): Promise<void> {
    try {
      // Flush any pending SimpleStorage writes
      await this.simpleStorage.flush()
      console.log("SimpleStorage flushed on disconnect")
    } catch (error) {
      console.error("Error flushing SimpleStorage on disconnect:", error)
      // Continue with disconnect even if flush fails
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }
}
```

**Developer usage:**

```typescript
// Automatic flush on graceful shutdown
process.on("SIGTERM", async () => {
  await session.disconnect() // Flushes SimpleStorage
  process.exit(0)
})

// Manual flush for critical moments
await session.simpleStorage.flush() // Force immediate persistence
```

## Migration Strategy

### Phase 1: Deploy Cloud Changes (No Impact)

1. Deploy rate limiting middleware (100 req/min)
2. Deploy validation to `simple-storage.service.ts`
3. Update API error handling
4. **Result**: Existing SDK versions protected, no breaking changes

### Phase 2: SDK Update (Backward Compatible)

1. Publish new SDK version with debounce batching (3s/10s)
2. Add flush-on-disconnect to AppSession
3. Add explicit `flush()` method
4. Update SDK docs with mental model and limits
5. Notify developers via email (1 week notice)
6. **Result**: New Apps get batching + auto-flush, old Apps still work

### Phase 3: Monitor & Adjust

1. Watch Prometheus metrics for:
   - Batch sizes (should be 5-20x larger than before)
   - Limit violations (should be rare)
   - Flush-on-disconnect success rate
2. Adjust timings if needed (3s/10s → 5s/15s?)
3. Contact developers hitting limits with migration guidance

### Rollback Plan

- Rate limiting: Turn off via feature flag
- Validation: Return warnings instead of errors (temporary)
- SDK debouncing: No rollback needed (client-side only)
- Flush-on-disconnect: No rollback needed (client-side only)

## Monitoring & Metrics

**Prometheus Metrics to Add:**

```typescript
// In simple-storage.service.ts
import {prometheusRegistry} from "../../services/prometheus"

const storageMetrics = {
  valueSizeExceeded: new Counter({
    name: "simple_storage_value_size_exceeded_total",
    help: "Count of values exceeding 100KB limit",
    labelNames: ["packageName"],
  }),

  totalSizeExceeded: new Counter({
    name: "simple_storage_total_size_exceeded_total",
    help: "Count of storage exceeding 1MB limit",
    labelNames: ["packageName"],
  }),

  rateLimitHit: new Counter({
    name: "simple_storage_rate_limit_hit_total",
    help: "Count of rate limit violations",
    labelNames: ["packageName"],
  }),

  batchSize: new Histogram({
    name: "simple_storage_batch_size",
    help: "Keys per flush (expect 5-50 with debouncing)",
    buckets: [1, 2, 5, 10, 20, 50, 100],
  }),

  flushTrigger: new Counter({
    name: "simple_storage_flush_trigger_total",
    help: "How flush was triggered",
    labelNames: ["trigger"], // 'debounce', 'maxwait', 'disconnect', 'explicit'
  }),

  debounceDelay: new Histogram({
    name: "simple_storage_debounce_delay_seconds",
    help: "Time from first write to flush",
    buckets: [1, 2, 3, 5, 10, 15, 20],
  }),
}
```

## Testing Strategy

### Unit Tests

```typescript
// SDK tests
describe("SimpleStorage validation", () => {
  it("throws error for value >100KB", async () => {
    const largeValue = "x".repeat(100_001)
    await expect(storage.set("key", largeValue)).rejects.toThrow("exceeds 100KB limit")
  })

  it("debounces multiple rapid set() calls", async () => {
    const fetchSpy = jest.spyOn(global, "fetch")

    storage.set("a", "1") // t=0
    await new Promise((r) => setTimeout(r, 500))
    storage.set("b", "2") // t=500ms
    await new Promise((r) => setTimeout(r, 500))
    storage.set("c", "3") // t=1000ms

    // Wait for debounce (3s after last write)
    await new Promise((r) => setTimeout(r, 3500))

    // Should batch into single request
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({data: {a: "1", b: "2", c: "3"}}),
      }),
    )
  })

  it("flushes after max wait even with constant writes", async () => {
    const fetchSpy = jest.spyOn(global, "fetch")

    // Write every 2 seconds for 12 seconds
    for (let i = 0; i < 6; i++) {
      storage.set(`key${i}`, `val${i}`)
      if (i < 5) await new Promise((r) => setTimeout(r, 2000))
    }

    // Should flush at 10s max wait (not wait forever)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("flushes on explicit disconnect", async () => {
    const fetchSpy = jest.spyOn(global, "fetch")

    storage.set("a", "1")
    storage.set("b", "2")

    // Disconnect before debounce timer
    await session.disconnect()

    // Should flush immediately
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

// Cloud tests
describe("SimpleStorage service validation", () => {
  it("rejects value >100KB", async () => {
    const largeValue = "x".repeat(100_001)
    await expect(setKey("test@test.com", "com.test", "key", largeValue)).rejects.toThrow("exceeds 100KB limit")
  })

  it("rejects when total >1MB", async () => {
    // Set up storage with 950KB
    const existingData = {big: "x".repeat(950_000)}
    await updateMany("test@test.com", "com.test", existingData)

    // Try to add 100KB more
    const newValue = "x".repeat(100_000)
    await expect(setKey("test@test.com", "com.test", "key2", newValue)).rejects.toThrow("exceeds 1MB limit")
  })
})
```

### Integration Tests

1. Create test App with SDK
2. Rapidly call `set()` 100 times in loop
3. Verify ~10 HTTP requests (debouncing works with max wait)
4. Test graceful shutdown flushes pending writes
5. Test app restart restores from MongoDB

## Open Questions

1. **Debounce timing: 3s/10s vs 5s/30s vs 1s/5s?**
   - 3s/10s: Good balance (current choice)
   - 5s/30s: More batching, feels slower
   - 1s/5s: More responsive, less batching
   - **Decision**: Start with 3s/10s, adjust based on metrics

2. **Rate limit needed with debouncing?**
   - With 3s/10s debouncing, most apps will stay under 10 req/min
   - Still useful as safety net for bugs/broken clients
   - **Decision**: 100 req/min (generous backup protection)

3. **Rate limit per what?**
   - Per `(email, packageName)` ✓ (current design)
   - Per `packageName` only (easier to abuse)
   - Per IP address (doesn't work for App servers)
   - **Decision**: Per `(email, packageName)` is correct

4. **Grandfather existing large values?**
   - Allow reads but prevent updates (complex)
   - Leave as-is (simple, no breaking changes)
   - **Decision**: Leave as-is for now

5. **Auto-flush on which events?**
   - disconnect() ✓ (always)
   - process.exit() ✓ (via disconnect)
   - Periodic interval? (unnecessary with debouncing)
   - **Decision**: Just disconnect() and explicit flush()

6. **Metrics storage: Prometheus vs MongoDB?**
   - Prometheus: Standard, works with existing stack ✓
   - MongoDB: More detailed, but separate system
   - **Decision**: Prometheus (already set up)
