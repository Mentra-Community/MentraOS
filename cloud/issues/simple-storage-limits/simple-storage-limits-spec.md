# SimpleStorage Limits & Rate Protection - Spec

## Overview

Add validation, size limits, and rate protection to SimpleStorage to prevent abuse. Uses aggressive debounce batching (3s idle / 10s max) since SimpleStorage is RAM-backed persistence, not real-time sync.

## Problem

SimpleStorage is MongoDB-backed key/value storage with no restrictions:

1. **Value size unlimited** - developers could serialize 10MB images, videos, or books
2. **Total storage unlimited** - each user+app combo could store GBs, bloating MongoDB
3. **No batching** - every `set()` = immediate HTTP request, wasting bandwidth and DB load
4. **RAM is source of truth** - MongoDB is just crash recovery backup, doesn't need instant sync

### Evidence

- Current MongoDB documents: `{ email, packageName, data: Record<string,string> }`
- No validation in `simple-storage.api.ts` or `simple-storage.service.ts`
- SDK `set()` calls `fetch()` immediately with no batching
- MongoDB document size limit: 16MB (we could hit this)
- **Key insight**: App server RAM is source of truth, MongoDB is just persistence backup

### Constraints

- **Zero breaking changes** - existing Apps must work without code changes
- **MongoDB-backed** - cannot change storage backend
- **RAM is source of truth** - MongoDB is backup for app restart/reconnect only
- **Developer experience** - clear error messages, not silent failures

## Goals

### Primary

1. **Enforce 100KB max per value** (both SDK + Cloud)
2. **Enforce 1MB total storage per user+app** (Cloud side)
3. **Debounce SDK writes** with 3s idle / 10s max (SDK side)
4. **Flush on disconnect** - persist final state when app stops (SDK side)
5. **Zero breaking changes** - existing code works

### Secondary

- Clear error messages with guidance (e.g., "Use S3 for large files")
- Prometheus metrics for limit violations
- Developer docs with examples

### Success Metrics

| Metric              | Current         | Target            |
| ------------------- | --------------- | ----------------- |
| Max value size      | Unlimited       | 100KB (enforced)  |
| Total storage/user  | Unlimited       | 1MB (enforced)    |
| SDK debounce        | 0ms (immediate) | 3s idle / 10s max |
| Flush on disconnect | No              | Yes               |
| Breaking changes    | N/A             | 0                 |

## Non-Goals

- Compression/deduplication (developers can do this themselves)
- Storage pricing/quotas (future feature)
- Migration of existing large values (grandfather clause - keep existing data as-is)
- Multi-region replication
- Versioning/history

## Detailed Requirements

### Value Size Limit: 100KB

**Why 100KB?**

- Covers typical use cases: user preferences (1-5KB), auth tokens (1KB), small JSON configs (10-50KB)
- Prevents abuse: cannot store base64 images (typical photo = 500KB+ encoded)
- MongoDB friendly: 10 keys × 100KB = 1MB document (well under 16MB limit)

**Enforcement:**

- SDK: Check `value.length` before HTTP call, throw `Error` if >100KB
- Cloud: Check `value.length` on PUT, return `400 Bad Request` if >100KB

**Error message:**

```
SimpleStorage value exceeds 100KB limit (current: 150KB).
For large files, use your own S3 bucket storage.
```

### Total Storage Limit: 1MB per user+app

**Why 1MB?**

- Generous for key/value data (1000 keys × 1KB each)
- Prevents runaway storage growth
- MongoDB document size = ~1MB (safe margin under 16MB limit)

**Enforcement:**

- Cloud only (SDK doesn't know total size without fetching everything)
- Before `setKey()` or `updateMany()`, calculate: `currentSize + newSize`
- Return `413 Payload Too Large` if exceeds 1MB

**Calculation:**

```typescript
const currentSize = Object.values(doc.data).reduce((sum, v) => sum + v.length, 0)
const newSize = Object.values(newData).reduce((sum, v) => sum + v.length, 0)
if (currentSize + newSize > 1_000_000) throw Error
```

**Error message:**

```
SimpleStorage total size exceeds 1MB limit (current: 950KB, attempted: 100KB).
Delete unused keys or use your own S3 bucket storage.
```

### SDK Debouncing: 3s idle / 10s max

**Why debounce with max wait?**

- **SimpleStorage mental model**: App server RAM = source of truth, MongoDB = backup
- User changes propagate instantly in RAM, MongoDB just needs eventual persistence
- 3 seconds idle: Perfect for "save after user stops typing/adjusting"
- 10 seconds max: Ensures periodic sync even during constant writes
- Way better batching: 100 rapid writes → 1-2 requests instead of 100

**Real-world scenarios:**

- User drags settings slider (50 changes in 3s) → wait 3s → flush final value → **1 request**
- User typing in text field → wait 3s after they stop → **1 request**
- App constantly updating (game state) → flush every 10s max → **6 requests/min**

**Implementation (debounce with max wait):**

```typescript
// SDK side
private pendingWrites = new Map<string, string>();
private debounceTimer?: NodeJS.Timeout;
private maxWaitTimer?: NodeJS.Timeout;

public async set(key: string, value: string): Promise<void> {
  // Validate size
  if (value.length > 100_000) {
    throw new Error(`SimpleStorage value exceeds 100KB limit (${value.length} bytes)`);
  }

  // Optimistic cache update (RAM = source of truth)
  if (this.storage) this.storage[key] = value;

  // Add to pending batch
  this.pendingWrites.set(key, value);

  // Clear existing debounce timer
  if (this.debounceTimer) {
    clearTimeout(this.debounceTimer);
  }

  // Set new debounce timer (3s idle)
  this.debounceTimer = setTimeout(() => this.flush(), 3000);

  // Start max wait timer if not already running (10s max)
  if (!this.maxWaitTimer) {
    this.maxWaitTimer = setTimeout(() => this.flush(), 10000);
  }
}

public async flush(): Promise<void> {
  if (this.pendingWrites.size === 0) return;

  // Clear timers
  if (this.debounceTimer) clearTimeout(this.debounceTimer);
  if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
  this.debounceTimer = undefined;
  this.maxWaitTimer = undefined;

  const batch = Object.fromEntries(this.pendingWrites);
  this.pendingWrites.clear();

  await fetch(`${baseUrl}/api/sdk/simple-storage/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({ data: batch })
  });
}
```

**Behavior:**

- `set("a", "1")` at t=0ms → starts 3s debounce + 10s max timers
- `set("b", "2")` at t=2s → resets 3s debounce, keeps 10s max
- `set("c", "3")` at t=4s → resets 3s debounce, keeps 10s max
- No more writes → flush at t=7s (3s after last write)
- **OR** if writes keep happening → flush at t=10s (max wait)
- Result: `PUT /api/sdk/simple-storage/:email` with `{a:"1", b:"2", c:"3"}`

### Flush on Disconnect

**Why flush on disconnect?**

- Ensures final state is persisted before app stops
- Prevents data loss on graceful shutdown
- No reliance on debounce timers

**Implementation:**

```typescript
// In AppSession disconnect handler
public async disconnect(): Promise<void> {
  // Flush any pending writes before closing connection
  await this.simpleStorage.flush();

  // Then close WebSocket
  this.ws?.close();
}
```

**Behavior:**

- App calls `session.disconnect()` or crashes
- SDK automatically flushes pending writes
- App can restart and restore from MongoDB

## Backward Compatibility

**Existing code must work without changes:**

```typescript
// Old SDK version (no batching, no validation)
session.simpleStorage.set("key", "value") // Still works

// Large existing values (grandfather clause)
// If user already has 2MB stored, don't break their app
// Just prevent NEW values from exceeding limits
```

**Migration strategy:**

- Existing storage documents untouched (no forced migration)
- New writes enforced immediately
- Developers notified via email about new limits (1 week warning)

## Open Questions

1. **Debounce timing: 3s/10s vs 5s/30s?**
   - 3s/10s: Fast enough to feel "saved", good batching
   - 5s/30s: Even better batching, but feels slow
   - **Decision**: Start with 3s/10s, can adjust based on metrics

2. **Grandfather existing large values?**
   - Option A: Migrate/delete large values (breaking change)
   - Option B: Allow read-only, prevent updates (complex)
   - Option C: Leave as-is, enforce only for new writes (simple)
   - **Decision**: Option C

3. **Error vs warning for size limits in SDK?**
   - Throw error: Forces developers to fix (but could break apps)
   - Console warning: Gentle, but developers might ignore
   - **Decision**: Throw error (with helpful message pointing to S3)

4. **Debounce `delete()` too?**
   - Yes: Consistent with `set()` debouncing
   - No: Deletes are rare, not worth complexity
   - **Decision**: Yes, use same debounce logic for consistency

5. **Rate limiting still needed?**
   - With 3s/10s debouncing, rate limiting less critical
   - Still useful as safety net for bugs/abuse
   - **Decision**: Add basic rate limiting (100 req/min) as backup protection
