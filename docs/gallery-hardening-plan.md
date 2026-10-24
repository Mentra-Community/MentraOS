# Gallery Hardening Plan

## Motivation

The MentraOS gallery sync pipeline has a structural bug that causes photos to silently disappear from the in-app gallery after syncing from glasses. The root cause is a **read-modify-write race condition** where two independent code paths concurrently write to a single MMKV key (`asg_downloaded_files`) that stores the entire gallery index as one JSON blob. This means that during a medium-to-large sync (5+ photos with image processing enabled), the second writer can overwrite the first writer's changes, erasing photos from the index while the files remain on disk.

Secondary issues include photos displaying out of chronological order (due to reliance on JS object insertion order rather than capture timestamps), and zero observability — no Sentry alerts or analytics events fire when photos vanish, so the problem is invisible to the team.

This plan fixes the bugs, adds observability tripwires, and performs cleanup — all with surgical changes. No architectural rewrite is needed.

---

## Current Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         GLASSES (asg_client)                          │
│  Camera → local storage → HTTP server on :8089                        │
│  Endpoints: /api/sync, /api/photo, /api/download, /api/delete-files   │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │ WiFi (glasses hotspot)
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ TRANSPORT (gallerySyncService.ts — 2015 lines)                        │
│  BLE hotspot negotiation → WiFi connect → HTTP sync → download        │
│  dispatch → progress tracking → cleanup → resume → cancel             │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ DOWNLOAD (asgCameraApi.ts — 1194 lines)                               │
│  syncWithServer() → batchSyncFiles() / downloadCapture()              │
│  RNFS.downloadFile to MentraPhotos/ with size validation              │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │ file on disk + enqueue
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ PROCESSING (mediaProcessingQueue.ts — 318 lines)                      │
│  Serial async queue. Per item:                                        │
│  1. HDR merge  2. Lens correction  3. Stabilization                   │
│  4. Thumbnail  5. Camera roll save  6. Save metadata ← WRITER 2      │
│  7. Update Zustand  8. Delete from glasses  9. Cleanup intermediates  │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ PERSISTENCE (localStorageService.ts — 494 lines)                      │
│                                                                        │
│  MMKV key: "asg_downloaded_files"                                      │
│  Value: { "IMG_001.jpg": { filePath, size, modified, ... }, ... }      │
│                                                                        │
│  Every write does a full read-modify-write:                            │
│    files = getDownloadedFiles()    // READ entire blob                  │
│    files[name] = entry             // MODIFY one key                   │
│    storage.save(KEY, files)        // WRITE entire blob back           │
│                                                                        │
│  NO LOCKING. Multiple concurrent callers.                              │
│                                                                        │
│  Filesystem: DocumentDir/MentraPhotos/ (photos)                        │
│              DocumentDir/MentraPhotos/thumbnails/ (thumbs)             │
│  Paths stored RELATIVE for iOS container UUID compat.                  │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ UI (GalleryScreen.tsx — 1533 lines)                                    │
│                                                                        │
│  loadDownloadedPhotos():                                               │
│    → getDownloadedFiles() → parallel RNFS.exists() validation          │
│    → delete "stale" entries → setDownloadedPhotos()                    │
│                                                                        │
│  allPhotos = useMemo:                                                  │
│    → syncQueue (sorted newest-first) + downloadedPhotos (sorted)       │
│    → concatenated: sync items on top, downloaded below                 │
│    → NOT a unified sort                                                │
│                                                                        │
│  FlatList grid → PhotoImage → MediaViewer                              │
│  Sync button → gallerySyncService.startSync()                          │
│  Selection mode → delete / share                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### The Double-Write Race (Primary Bug)

In the legacy sync path (`executeDownload`), metadata is written **twice** for each photo:

1. **Writer 1** — `gallerySyncService.ts` lines 1457–1474: After all downloads complete, loops through every downloaded file and calls `saveDownloadedFile()` with the **raw, unprocessed file path**. This code predates the processing queue and was never removed.

2. **Writer 2** — `mediaProcessingQueue.ts` line 243: After each file is processed (HDR/lens/stabilization), calls `saveDownloadedFile()` with the **final, processed file path**. This is the correct and authoritative writer.

Both writers perform unsynchronized read-modify-write on the same MMKV key. When they interleave, Writer B's `storage.save()` overwrites Writer A's changes, erasing photos from the index.

```
Timeline — 15-photo sync with processing enabled:

gallerySyncService              mediaProcessingQueue
(Writer 1 — post-download)     (Writer 2 — post-processing)

  saveDownloadedFile(A)
    READ  index = {old}
    WRITE index = {old, A_raw}
                                  processItem(A) done
                                  saveDownloadedFile(A)
                                    READ  index = {old, A_raw}
                                    WRITE index = {old, A_processed}
  saveDownloadedFile(B)
    READ  index = {old, A_processed}
    WRITE index = {old, A_processed, B_raw}
                                  processItem(B) done
                                  saveDownloadedFile(B)
                                    READ  index = {old, A_proc, B_raw}
                                    WRITE index = {old, A_proc, B_processed}

  saveDownloadedFile(C)
    READ  index = {old, A_proc, B_raw}   ← stale read (before B_processed)
    WRITE index = {old, A_proc, B_raw, C_raw}
                                         ↑ B_processed is GONE

Result: Photo B's processed entry is overwritten. If intermediate cleanup
deleted the raw file, B is now invisible in the gallery.
```

---

## Expected Architecture (After Fixes)

```
┌──────────────────────────────────────────────────────────────────────┐
│ TRANSPORT + DOWNLOAD — unchanged                                      │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ PROCESSING (mediaProcessingQueue.ts)                                  │
│  Same pipeline, but now the SOLE metadata writer.                     │
│  No more competing writes from gallerySyncService.                    │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ PERSISTENCE (localStorageService.ts)                                  │
│                                                                        │
│  NEW: Async write mutex around all index mutations.                    │
│  saveDownloadedFile(), deleteDownloadedFile(), clearAllFiles()          │
│  are serialized — no concurrent read-modify-write possible.            │
│                                                                        │
│  NEW: detectOrphans() — startup scan of MentraPhotos/ vs index.        │
│  NEW: cleanupArtifacts() — remove AVIF artifacts from index + disk.    │
│  NEW: MMKV keys for observability:                                     │
│    gallery_known_photo_count, gallery_user_deleted_count               │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ UI (GalleryScreen.tsx)                                                 │
│                                                                        │
│  CHANGED: loadDownloadedPhotos() skips stale cleanup when              │
│  syncing OR resumable queue exists.                                    │
│                                                                        │
│  CHANGED: allPhotos sorts the FINAL merged array by capture time       │
│  as one unified list (not two separately-sorted concatenated groups).  │
│                                                                        │
│  NEW: Concurrent load guard (useRef flag).                             │
│  NEW: Tripwire — photo count drop detection → Sentry alert.           │
│  NEW: Tripwire — out-of-order detection → Sentry warning.             │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ STARTUP (gallerySyncService.initialize)                                │
│                                                                        │
│  NEW: Orphan detection + Sentry reporting.                             │
│  NEW: AVIF artifact cleanup.                                           │
│  Both guarded: only run when idle AND no resumable queue.              │
└──────────────────────────────────────────────────────────────────────┘
```

### Key Architectural Change

**Before:** Two concurrent metadata writers (Writer 1 legacy loop + Writer 2 processing queue), no locking, gallery sorted by insertion order.

**After:** One metadata writer (processing queue only — Writer 1 deleted), all writes serialized by mutex, gallery sorted by capture time, anomaly detection on every load. Orphan detection on startup surfaces any files that were downloaded but not processed due to app kill or queue abort.

---

## Fixes

### Phase 1 — Critical Bug Fixes

#### Fix #1: Remove the Double-Write (Delete Writer 1)

- **File:** `mobile/src/services/asg/gallerySyncService.ts`
- **Lines:** 1457–1474
- **Change:** Delete the post-download metadata loop entirely. Writer 2 (processing queue) is the sole metadata writer going forward. It writes the correct final processed file path after HDR, lens correction, and stabilization complete.

**What to delete:**

```typescript
// Remove this entire block from executeDownload():
for (const photoInfo of downloadResult.downloaded) {
  const isAuxiliary =
    photoInfo.name?.match(/_ev-?\d+\.(jpg|jpeg)$/i) ||
    photoInfo.name?.match(/\.imu\.json$/i) ||
    photoInfo.name?.match(/\/ev-?\d+\.jpe?g$/i) ||
    photoInfo.name?.match(/\/imu\.json$/i)
  if (isAuxiliary) continue

  const downloadedFile = localStorageService.convertToDownloadedFile(
    photoInfo,
    photoInfo.filePath || "",
    photoInfo.thumbnailPath,
    defaultWearable,
  )
  await localStorageService.saveDownloadedFile(downloadedFile)
}
```

**Accepted trade-off:** If the app is killed mid-sync or the processing queue times out, photos that had not yet reached step 6 (metadata save) in the processing pipeline will be on disk but absent from the gallery index until the next sync retries them. This is the same behaviour users experience today when processing fails — it is now intentional rather than accidental. Fix #5 (orphan detection) surfaces these cases via Sentry on the next startup, and Tripwire T3 fires if orphans are found, so the team has visibility when this happens.

- **Risk:** Low for the happy path (processing completes). Accepted orphan risk on processing abort/app kill — mitigated by orphan detection (Fix #5) and T3 tripwire.
- **Effort:** 5 minutes

---

#### Fix #2: Add Write Mutex to localStorageService

- **File:** `mobile/src/services/asg/localStorageService.ts`
- **Change:** Add a promise-based async lock that serializes all read-modify-write operations on the `asg_downloaded_files` key.
- **What to add:**

```typescript
// New private field:
private _writeLock: Promise<void> = Promise.resolve()

// New private method:
private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void
  const next = new Promise<void>(resolve => { release = resolve })
  const prev = this._writeLock
  this._writeLock = next
  await prev
  try {
    return await fn()
  } finally {
    release!()
  }
}
```

- **What to wrap:** `saveDownloadedFile()`, `deleteDownloadedFile()`, and `clearAllFiles()` — wrap their existing bodies in `return this.withWriteLock(async () => { ... })`.
- **Risk:** Minimal. Serializes writes, adds negligible latency (<5ms per write). Does not affect reads.
- **Effort:** 30 minutes

---

#### Fix #3: Skip Stale Cleanup During Active Sync or Resumable Queue

- **File:** `mobile/src/components/glasses/Gallery/GalleryScreen.tsx`
- **Location:** `loadDownloadedPhotos()`, around line 218
- **Change:** Guard the stale-entry deletion loop so it only runs when no sync is active AND no persisted resumable queue exists.
- **Why the resumable queue check:** If the app crashed mid-sync, Zustand resets `syncState` to `"idle"` on relaunch, but the persisted queue still exists. Without this check, stale cleanup would delete entries for files that were mid-processing when the crash happened.
- **What to change:**

```typescript
// Before (current):
for (const fileName of staleFileNames) {
  await localStorageService.deleteDownloadedFile(fileName)
}

// After:
const hasResumableQueue = await localStorageService.hasResumableSyncQueue()
if (syncState !== "syncing" && !hasResumableQueue) {
  for (const fileName of staleFileNames) {
    await localStorageService.deleteDownloadedFile(fileName)
  }
  if (staleFileNames.length > 0) {
    console.log(`[GalleryScreen] Cleaned up ${staleFileNames.length} stale photo entries`)
  }
} else if (staleFileNames.length > 0) {
  console.log(`[GalleryScreen] Skipping stale cleanup (sync active or resumable) - ${staleFileNames.length} entries`)
}
```

- **Risk:** During sync, stale entries temporarily remain. They are cleaned up on the next idle load (sync completion triggers `loadDownloadedPhotos()` again).
- **Effort:** 5 minutes

---

### Phase 2 — Display & Data Quality

#### Fix #4: Unified Sort by Capture Time

- **File:** `mobile/src/components/glasses/Gallery/GalleryScreen.tsx`
- **Location:** `allPhotos` useMemo, around lines 701–790
- **Change:** Instead of sorting `syncQueue` and `downloadedPhotos` independently then concatenating (sync items always on top), merge everything into one array and sort by `modified` (capture time) as a single unified list.
- **Current behavior:** Syncing photos always appear above existing photos regardless of when they were captured. When sync completes and the queue clears, photos visibly jump positions.
- **Expected behavior:** All photos sorted newest-first by capture time, regardless of whether they are from the sync queue or local storage.
- **What to change:** After building the combined `items` array (sync + downloaded), sort the entire array:

```typescript
items.sort((a, b) => {
  const aTime = typeof a.photo?.modified === "number" ? a.photo.modified : new Date(a.photo?.modified || 0).getTime()
  const bTime = typeof b.photo?.modified === "number" ? b.photo.modified : new Date(b.photo?.modified || 0).getTime()
  return bTime - aTime
})
```

- **Risk:** None. Purely changes display order, does not affect stored data.
- **Effort:** 15 minutes

---

#### Fix #5: Orphan Detection + AVIF Artifact Cleanup on Startup

- **File:** `mobile/src/services/asg/localStorageService.ts` (new methods)
- **Caller:** `mobile/src/services/asg/gallerySyncService.ts` — `initialize()`
- **Change:** Add two maintenance methods that run once on app startup.

**Orphan detection** — scans `MentraPhotos/` directory and compares against the MMKV index. Files on disk with no index entry are orphans (evidence of a crash during sync). Reports via Sentry.

```typescript
async detectOrphans(): Promise<{orphanCount: number, orphanNames: string[]}> {
  const filesOnDisk = await RNFS.readDir(this.ASG_PHOTOS_DIR)
  const indexedFiles = await this.getDownloadedFiles()
  const indexedNames = new Set(Object.keys(indexedFiles))

  const orphans = filesOnDisk.filter(f => {
    if (f.name === 'thumbnails') return false
    if (f.name.match(/\.(hdr|processed)\.(jpg|jpeg)$/i)) return false
    if (f.name.match(/\.stabilized\.mp4$/i)) return false
    return !indexedNames.has(f.name)
  })

  return { orphanCount: orphans.length, orphanNames: orphans.map(f => f.name) }
}
```

**AVIF artifact cleanup** — removes known artifact patterns (filenames like `I123`, `ble_456`, pure digits, `.avif`/`.avifs`) from both the index and disk. These are transfer artifacts from BLE that are currently filtered from display but accumulate on disk.

```typescript
async cleanupArtifacts(): Promise<number> {
  const files = await this.getDownloadedFiles()
  const artifactNames = Object.keys(files).filter(name =>
    name.match(/^I\d+$/) ||
    name.match(/^ble_\d+$/) ||
    name.match(/^\d+$/) ||
    name.endsWith('.avif') ||
    name.endsWith('.avifs')
  )

  for (const name of artifactNames) {
    await this.deleteDownloadedFile(name)
  }

  if (artifactNames.length > 0) {
    console.log(`[LocalStorage] Cleaned up ${artifactNames.length} AVIF artifacts`)
  }
  return artifactNames.length
}
```

**Call site** — in `gallerySyncService.initialize()`, after the existing `checkForResumableSync()`:

```typescript
const hasResumable = await localStorageService.hasResumableSyncQueue()
if (!hasResumable) {
  await localStorageService.cleanupArtifacts()
  const orphanResult = await localStorageService.detectOrphans()
  // Sentry reporting handled by Tripwire T3
}
```

- **Risk:** Read-only scan for orphans, guarded deletion for artifacts. Only runs on startup when idle with no resumable queue.
- **Effort:** 1 hour

---

#### Fix #6: Normalize `modified` Field to Number + Sanity Bounds

- **Files:**
  - `mobile/src/services/asg/asgCameraApi.ts` — ingestion boundary
  - `mobile/src/services/asg/localStorageService.ts` — `convertToDownloadedFile()`
  - `mobile/src/services/asg/gallerySyncService.ts` — remove defensive parsing
  - `mobile/src/services/asg/mediaProcessingQueue.ts` — remove defensive parsing
- **Change:** The `modified` field on `PhotoInfo` is currently `string | number` depending on whether it comes from the glasses server (ISO string) or internal code (Unix millis). Every consumer has its own defensive parsing. This creates risk of `NaN` propagating into sort comparisons and watermark logic.

**Add a shared normalizer** (can live in `localStorageService.ts` or a utils file):

```typescript
const MIN_VALID_TIMESTAMP = new Date("2020-01-01").getTime()

function normalizeTimestamp(raw: string | number | undefined): number {
  if (raw === undefined || raw === null) return Date.now()
  const parsed = typeof raw === "number" ? raw : new Date(raw).getTime()
  const maxValid = Date.now() + 365 * 24 * 60 * 60 * 1000

  if (isNaN(parsed) || parsed < MIN_VALID_TIMESTAMP || parsed > maxValid) {
    console.warn(`[Gallery] Invalid timestamp: ${raw}, using current time`)
    return Date.now()
  }
  return parsed
}
```

**Apply at ingestion** — in `syncWithServer` response, normalize each file's `modified` immediately. In `convertToDownloadedFile`, use the normalizer instead of raw `new Date()`.

**Remove downstream defensive parsing** — the `typeof modified === "string" ? parseInt(...)` patterns in `gallerySyncService.ts` (lines ~1384, ~1498, ~1782) and `mediaProcessingQueue.ts` become unnecessary.

- **Risk:** Low. Invalid timestamps fall back to `Date.now()` instead of propagating `NaN`.
- **Effort:** 30 minutes

---

#### Fix #11: Concurrent Gallery Load Protection

- **File:** `mobile/src/components/glasses/Gallery/GalleryScreen.tsx`
- **Change:** Add a `useRef` guard to prevent multiple concurrent `loadDownloadedPhotos()` calls when the user rapidly navigates in and out of the gallery.
- **What to add:**

```typescript
const isLoadingRef = useRef(false)

const loadDownloadedPhotos = useCallback(async () => {
  if (isLoadingRef.current) {
    console.log("[GalleryScreen] Already loading, skipping concurrent call")
    return
  }
  isLoadingRef.current = true
  try {
    // ... existing load logic ...
  } finally {
    isLoadingRef.current = false
  }
}, [completedFiles])
```

- **Risk:** None. Prevents redundant parallel disk I/O.
- **Effort:** 5 minutes

---

### Phase 3 — Observability (Tripwires)

All tripwires use Sentry for error/warning reports and Firebase Analytics for event tracking. Neither exists in the gallery pipeline today — there is zero observability.

#### Tripwire T1: Photo Disappearance Detection

- **File:** `mobile/src/components/glasses/Gallery/GalleryScreen.tsx` — in `loadDownloadedPhotos()` after validation completes
- **New MMKV keys:**
  - `gallery_known_photo_count` — last validated photo count
  - `gallery_user_deleted_count` — accumulator for user-initiated deletions
  - `gallery_user_cleared_all` — boolean flag, set to `true` by the "Clear All" handler before wiping, reset to `false` after the tripwire reads it
- **Logic:**
  - After validation, compare `currentCount` against `previousCount - userDeleted`.
  - Compute `unexplainedLoss = previousCount - userDeleted - currentCount`.
  - If `unexplainedLoss > 0` AND `syncState === "idle"`: fire Sentry error regardless of whether `currentCount` is zero or non-zero — **a full wipe is the highest-severity case, not a silent reset.**
  - **Exception — explicit "Clear All":** If `gallery_user_cleared_all === true`, suppress the alert and reset the flag. This is the only legitimate zero-count state.
  - **Exception — first run:** If `previousCount === 0` (no prior record), this is a fresh install. Skip the check and seed `gallery_known_photo_count`.
  - Always reset: `save('gallery_known_photo_count', currentCount)`, `save('gallery_user_deleted_count', 0)`.
- **User-delete tracking hook points:**
  - Gallery selection delete handler: increment `gallery_user_deleted_count` by `selectedPhotos.length`.
  - Gallery settings "Clear All" handler: set `gallery_user_cleared_all` to `true` AND `gallery_known_photo_count` to `0` before wiping — both are needed to suppress the tripwire correctly.
- **Effort:** 30 minutes

#### Tripwire T2: Out-of-Order Detection

- **File:** `mobile/src/components/glasses/Gallery/GalleryScreen.tsx` — after building sorted `allPhotos`
- **Logic:**
  - Walk the sorted array. For each adjacent pair, if the later item has a capture time more than 2 seconds _newer_ than the earlier item (in a newest-first sort, this means they are out of order): count it.
  - Skip pairs where either timestamp is 0, NaN, or invalid.
  - If `outOfOrderCount > 0`: fire Sentry warning (once per app session, using a module-level flag).
- **Effort:** 20 minutes

#### Tripwire T3: Orphan File Detection

- **File:** `mobile/src/services/asg/gallerySyncService.ts` — in `initialize()`, using `detectOrphans()` from Fix #5
- **Logic:**
  - Only run when `syncState === "idle"` AND no resumable queue exists.
  - If `orphanCount > 0`: fire Sentry warning with `orphanCount`, `orphanNames` (first 20), `indexedCount`.
- **Effort:** 30 minutes

---

## Execution Order

Items are ordered by dependency — later items may depend on earlier ones being in place.

```
PHASE 1 — Critical Bug Fixes (do first, in this order)
  #1  Delete Writer 1 from executeDownload                5 min    gallerySyncService.ts
  #2  Add write mutex to localStorageService              30 min   localStorageService.ts
  #3  Skip stale cleanup during sync + resumable queue    5 min    GalleryScreen.tsx

PHASE 2 — Display & Data Quality (can be done in parallel after Phase 1)
  #4  Unified sort by capture time                        15 min   GalleryScreen.tsx
  #5  Orphan detection + AVIF artifact cleanup            1 hr     localStorageService.ts + gallerySyncService.ts
  #6  Normalize modified field + sanity bounds            30 min   asgCameraApi.ts + localStorageService.ts + others
  #11 Concurrent load protection                          5 min    GalleryScreen.tsx

PHASE 3 — Observability (depends on Phase 1 + 2)
  T1  Photo disappearance tripwire                        30 min   GalleryScreen.tsx
  T2  Out-of-order tripwire                               20 min   GalleryScreen.tsx
  T3  Orphan detection tripwire                           30 min   gallerySyncService.ts

PHASE 4 — Automated Tests (after all fixes are in place)
  localStorageService.test.ts                             45 min   ~8 tests (mutex, orphans, artifacts, paths)
  normalizeTimestamp.test.ts                              20 min   ~7 tests (timestamp normalization + bounds)
  gallerySyncService.test.ts                              20 min   ~2 tests (regression: no saveDownloadedFile from download paths)
  gallerySort.test.ts                                     20 min   ~4 tests (unified sort)
  galleryTripwires.test.ts                                30 min   ~10 tests (count drop, full-wipe alert, Clear All guard, first-run guard, order check)

TOTAL ESTIMATED EFFORT:                                   ~7–8 hours
  Fixes + observability:                                  ~4–5 hours
  Tests:                                                  ~2–3 hours
```

---

## Files Changed

| File                                                      | Changes                                                                                                                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mobile/src/services/asg/gallerySyncService.ts`           | Delete post-download metadata loop (Fix #1). Add startup orphan detection + artifact cleanup call (Fix #5). Add Tripwire T3 Sentry call. Remove defensive `modified` parsing (Fix #6).                                                |
| `mobile/src/services/asg/localStorageService.ts`          | Add write mutex (Fix #2). Add `detectOrphans()` and `cleanupArtifacts()` methods (Fix #5). Add `normalizeTimestamp()` helper and use in `convertToDownloadedFile()` (Fix #6).                                                         |
| `mobile/src/components/glasses/Gallery/GalleryScreen.tsx` | Guard stale cleanup (Fix #3). Unified sort in `allPhotos` useMemo (Fix #4). Concurrent load guard (Fix #11). Tripwire T1 (count drop + full-wipe detection). Tripwire T2 (order check). Track user deletions + `userClearedAll` flag. |
| `mobile/src/services/asg/asgCameraApi.ts`                 | Normalize `modified` at ingestion in `syncWithServer` response (Fix #6).                                                                                                                                                              |
| `mobile/src/services/asg/mediaProcessingQueue.ts`         | Remove defensive `modified` parsing (Fix #6).                                                                                                                                                                                         |
| `mobile/src/app/asg/gallery-settings.tsx`                 | Set `gallery_known_photo_count` to 0 AND `gallery_user_cleared_all` to `true` before "Clear All" (T1 false-alarm guard).                                                                                                              |
| `mobile/src/app/miniapps/gallery/gallery-settings.tsx`    | Same as above.                                                                                                                                                                                                                        |
| `mobile/src/services/asg/localStorageService.test.ts`     | **NEW.** ~8 tests: mutex serialization, concurrent save+delete, path handling, orphan detection, artifact cleanup.                                                                                                                    |
| `mobile/src/services/asg/gallerySyncService.test.ts`      | **NEW.** ~2 tests: regression tests verifying no direct `saveDownloadedFile` calls from download paths.                                                                                                                               |
| `mobile/src/utils/normalizeTimestamp.test.ts`             | **NEW.** ~7 tests: valid millis, ISO string conversion, NaN/zero/far-future fallback, undefined handling.                                                                                                                             |
| `mobile/src/utils/gallerySort.test.ts`                    | **NEW.** ~4 tests: unified sort, interleaving sync+local, mixed timestamp types, invalid timestamps.                                                                                                                                  |
| `mobile/src/utils/galleryTripwires.test.ts`               | **NEW.** ~8 tests: count drop detection, user-delete tolerance, sync-active guard, fresh-install guard, partial loss, order check, burst tolerance, invalid timestamp skip.                                                           |

---

## Automated Testing

The gallery pipeline currently has near-zero test coverage — only 3 tests for Zustand store queue math (`gallerySync.test.ts`). None of the services (`localStorageService`, `gallerySyncService`, `mediaProcessingQueue`) or the gallery display logic have any tests.

The fixes in this plan introduce testable pure logic that should be covered by unit tests. To keep tests clean and fast, logic for tripwires and sorting should be extracted into pure functions rather than tested inline within React components.

Test infrastructure: Jest + jest-expo + @testing-library/react-native (already configured in `package.json`).

### Test File 1: `localStorageService.test.ts`

Tests the persistence layer — the most critical layer to cover since it's where data loss occurs.

**Mutex serialization (Fix #2) — the single most important test:**

```typescript
it("serializes concurrent saveDownloadedFile calls", async () => {
  await localStorageService.saveDownloadedFile(makeFile("A.jpg"))

  // Without mutex, one of these would overwrite the other
  await Promise.all([
    localStorageService.saveDownloadedFile(makeFile("B.jpg")),
    localStorageService.saveDownloadedFile(makeFile("C.jpg")),
  ])

  const files = await localStorageService.getDownloadedFiles()
  expect(Object.keys(files)).toContain("A.jpg")
  expect(Object.keys(files)).toContain("B.jpg")
  expect(Object.keys(files)).toContain("C.jpg")
})
```

**Concurrent save + delete (Fix #2):**

```typescript
it("serializes save and delete without data loss", async () => {
  await localStorageService.saveDownloadedFile(makeFile("A.jpg"))
  await localStorageService.saveDownloadedFile(makeFile("B.jpg"))

  await Promise.all([
    localStorageService.deleteDownloadedFile("A.jpg"),
    localStorageService.saveDownloadedFile(makeFile("C.jpg")),
  ])

  const files = await localStorageService.getDownloadedFiles()
  expect(Object.keys(files)).not.toContain("A.jpg")
  expect(Object.keys(files)).toContain("B.jpg")
  expect(Object.keys(files)).toContain("C.jpg")
})
```

**Relative path storage + reconstruction:**

```typescript
it("stores relative paths and reconstructs absolute paths", async () => {
  const absolutePath = `${RNFS.DocumentDirectoryPath}/MentraPhotos/test.jpg`
  await localStorageService.saveDownloadedFile(makeFile("test.jpg", absolutePath))

  const files = await localStorageService.getDownloadedFiles()
  expect(files["test.jpg"].filePath).toBe(absolutePath)
})
```

**AVIF artifact cleanup (Fix #5):**

```typescript
it("cleanupArtifacts removes known artifact patterns", async () => {
  await localStorageService.saveDownloadedFile(makeFile("I12345"))
  await localStorageService.saveDownloadedFile(makeFile("ble_678"))
  await localStorageService.saveDownloadedFile(makeFile("99999"))
  await localStorageService.saveDownloadedFile(makeFile("real_photo.jpg"))

  const cleaned = await localStorageService.cleanupArtifacts()

  expect(cleaned).toBe(3)
  const files = await localStorageService.getDownloadedFiles()
  expect(Object.keys(files)).toEqual(["real_photo.jpg"])
})
```

**Orphan detection (Fix #5):**

```typescript
it("detectOrphans finds files on disk not in index", async () => {
  // Mock RNFS.readDir to return ['indexed.jpg', 'orphan.jpg', 'thumbnails']
  await localStorageService.saveDownloadedFile(makeFile("indexed.jpg"))

  const result = await localStorageService.detectOrphans()
  expect(result.orphanNames).toContain("orphan.jpg")
  expect(result.orphanNames).not.toContain("indexed.jpg")
  expect(result.orphanNames).not.toContain("thumbnails")
})

it("detectOrphans ignores processing intermediates", async () => {
  // Mock RNFS.readDir to return intermediate files
  const result = await localStorageService.detectOrphans()
  expect(result.orphanNames).not.toContain("photo.jpg.hdr.jpg")
  expect(result.orphanNames).not.toContain("photo.jpg.processed.jpg")
  expect(result.orphanNames).not.toContain("photo.jpg.stabilized.mp4")
})
```

---

### Test File 2: `normalizeTimestamp.test.ts`

Tests the shared timestamp normalizer function (Fix #6).

```typescript
it("passes through valid Unix millis", () => {
  const now = Date.now()
  expect(normalizeTimestamp(now)).toBe(now)
})

it("converts ISO string to millis", () => {
  const iso = "2025-06-15T12:00:00.000Z"
  expect(normalizeTimestamp(iso)).toBe(new Date(iso).getTime())
})

it("falls back to Date.now() for NaN", () => {
  const before = Date.now()
  expect(normalizeTimestamp("not-a-date")).toBeGreaterThanOrEqual(before)
})

it("falls back to Date.now() for zero", () => {
  const before = Date.now()
  expect(normalizeTimestamp(0)).toBeGreaterThanOrEqual(before)
})

it("falls back to Date.now() for timestamps before 2020", () => {
  const result = normalizeTimestamp(946684800000) // year 2000
  expect(result).toBeGreaterThan(new Date("2020-01-01").getTime())
})

it("falls back to Date.now() for far-future timestamps", () => {
  const farFuture = Date.now() + 2 * 365 * 24 * 60 * 60 * 1000
  expect(normalizeTimestamp(farFuture)).toBeLessThan(farFuture)
})

it("handles undefined gracefully", () => {
  const before = Date.now()
  expect(normalizeTimestamp(undefined)).toBeGreaterThanOrEqual(before)
})
```

---

### Test File 3: `gallerySyncService.test.ts`

Regression tests verifying Writer 1 has been removed — `executeDownload` must never call `saveDownloadedFile` directly (Fix #1).

```typescript
it("executeDownload does not call saveDownloadedFile directly", async () => {
  // Mock asgCameraApi.batchSyncFiles to return 3 downloaded files
  // Spy on localStorageService.saveDownloadedFile
  await service.executeDownload(mockFiles, mockServerTime)

  // Writer 1 is gone — saveDownloadedFile must NOT be called from here
  expect(localStorageService.saveDownloadedFile).not.toHaveBeenCalled()
  // Processing queue must still be enqueued for each file
  expect(mediaProcessingQueue.enqueue).toHaveBeenCalledTimes(3)
})

it("executeCaptureDownload does not call saveDownloadedFile directly", async () => {
  await service.executeCaptureDownload(mockCaptures, mockServerTime)

  expect(localStorageService.saveDownloadedFile).not.toHaveBeenCalled()
})
```

---

### Test File 4: `gallerySort.test.ts`

Tests the unified sort logic (Fix #4). The sort comparator should be extracted into a standalone function for testability.

```typescript
it("sorts all photos by capture time newest-first", () => {
  const photos = [makeGalleryItem("old.jpg", 1000), makeGalleryItem("new.jpg", 3000), makeGalleryItem("mid.jpg", 2000)]
  const sorted = sortGalleryItems(photos)
  expect(sorted.map((p) => p.photo.name)).toEqual(["new.jpg", "mid.jpg", "old.jpg"])
})

it("interleaves sync queue and downloaded photos by capture time", () => {
  const items = [
    makeGalleryItem("sync.jpg", 2000, "server"),
    makeGalleryItem("local_old.jpg", 1000, "local"),
    makeGalleryItem("local_new.jpg", 3000, "local"),
  ]
  const sorted = sortGalleryItems(items)
  expect(sorted.map((p) => p.photo.name)).toEqual(["local_new.jpg", "sync.jpg", "local_old.jpg"])
})

it("handles mixed string and number timestamps without throwing", () => {
  const photos = [makeGalleryItem("a.jpg", "2025-01-01T00:00:00Z"), makeGalleryItem("b.jpg", 1735689600000)]
  expect(() => sortGalleryItems(photos)).not.toThrow()
  expect(sortGalleryItems(photos)).toHaveLength(2)
})

it("puts photos with invalid timestamps at the end", () => {
  const photos = [makeGalleryItem("valid.jpg", Date.now()), makeGalleryItem("invalid.jpg", 0)]
  const sorted = sortGalleryItems(photos)
  expect(sorted[0].photo.name).toBe("valid.jpg")
})
```

---

### Test File 5: `galleryTripwires.test.ts`

Tests the observability logic (T1, T2). The tripwire logic should be extracted into pure functions for testability.

**T1 — Photo count drop detection:**

```typescript
it("detects unexplained photo count drop", () => {
  const result = checkPhotoCountDrop({
    previousCount: 20,
    currentCount: 15,
    userDeleted: 0,
    syncState: "idle",
  })
  expect(result.shouldAlert).toBe(true)
  expect(result.unexplainedLoss).toBe(5)
})

it("does not alert when user deleted photos", () => {
  const result = checkPhotoCountDrop({
    previousCount: 20,
    currentCount: 15,
    userDeleted: 5,
    syncState: "idle",
  })
  expect(result.shouldAlert).toBe(false)
})

it("does not alert during active sync", () => {
  const result = checkPhotoCountDrop({
    previousCount: 20,
    currentCount: 15,
    userDeleted: 0,
    syncState: "syncing",
  })
  expect(result.shouldAlert).toBe(false)
})

it("alerts on catastrophic full-count wipe", () => {
  // previousCount > 0, currentCount === 0, no user deletes, no explicit Clear All
  const result = checkPhotoCountDrop({
    previousCount: 20,
    currentCount: 0,
    userDeleted: 0,
    syncState: "idle",
    userClearedAll: false,
  })
  expect(result.shouldAlert).toBe(true)
  expect(result.unexplainedLoss).toBe(20)
})

it("does not alert when user explicitly tapped Clear All", () => {
  const result = checkPhotoCountDrop({
    previousCount: 20,
    currentCount: 0,
    userDeleted: 0,
    syncState: "idle",
    userClearedAll: true,
  })
  expect(result.shouldAlert).toBe(false)
})

it("does not alert on first run (previousCount === 0)", () => {
  const result = checkPhotoCountDrop({
    previousCount: 0,
    currentCount: 0,
    userDeleted: 0,
    syncState: "idle",
    userClearedAll: false,
  })
  expect(result.shouldAlert).toBe(false)
})

it("detects partial unexplained loss alongside user deletes", () => {
  const result = checkPhotoCountDrop({
    previousCount: 20,
    currentCount: 15,
    userDeleted: 3,
    syncState: "idle",
  })
  expect(result.shouldAlert).toBe(true)
  expect(result.unexplainedLoss).toBe(2)
})
```

**T2 — Out-of-order detection:**

```typescript
it("detects out-of-order photos", () => {
  // newest-first: 3000, 1000, 2000 — the 2000 after 1000 is out of order
  const photos = [{modified: 3000}, {modified: 1000}, {modified: 2000}]
  const result = checkPhotoOrder(photos)
  expect(result.outOfOrderCount).toBe(1)
})

it("ignores differences under 2 seconds (burst photos)", () => {
  const photos = [{modified: 3000}, {modified: 2999}]
  const result = checkPhotoOrder(photos)
  expect(result.outOfOrderCount).toBe(0)
})

it("ignores photos with invalid timestamps", () => {
  const photos = [{modified: 3000}, {modified: 0}, {modified: 1000}]
  const result = checkPhotoOrder(photos)
  expect(result.outOfOrderCount).toBe(0)
})
```

---

### Test Summary

| Test File                     | # Tests | Covers                                                                               |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `localStorageService.test.ts` | ~8      | Fix #2 (mutex), Fix #5 (orphans, artifacts), path handling                           |
| `normalizeTimestamp.test.ts`  | ~7      | Fix #6 (timestamp normalization + bounds)                                            |
| `gallerySyncService.test.ts`  | ~2      | Fix #1 (regression: no direct saveDownloadedFile calls from either download path)    |
| `gallerySort.test.ts`         | ~4      | Fix #4 (unified sort by capture time)                                                |
| `galleryTripwires.test.ts`    | ~10     | T1 (count drop, full-wipe alert, Clear All guard, first-run guard), T2 (order check) |
| **Total**                     | **~31** |                                                                                      |

### Implementation Notes

- **Extract pure functions for testability.** The sort comparator, `checkPhotoCountDrop`, and `checkPhotoOrder` should be standalone exported functions (not inline in React components). This allows unit testing without mounting `GalleryScreen`.
- **Mock RNFS for `localStorageService` tests.** `RNFS.exists`, `RNFS.readDir`, `RNFS.unlink` need jest mocks. MMKV can use the real in-memory implementation (already works in tests per `storage.test.ts`).
- **Mock native modules for `gallerySyncService` tests.** `CoreModule`, `WifiManager`, `CrustModule`, and `asgCameraApi` all need mocks. Focus the tests on verifying call patterns (what was called and what was NOT called), not on end-to-end behavior.
- **The concurrent write test is the most valuable single test.** It directly reproduces the bug that causes photos to vanish. If that test passes with the mutex in place, the core fix is verified.

### Estimated Testing Effort

Writing all 5 test files with mocks: **~2–3 hours** additional on top of the fix effort.

---

## What This Does NOT Change

- **Transport layer** — hotspot negotiation, WiFi connection, retry logic are untouched.
- **Processing pipeline** — HDR merge, lens correction, stabilization, camera roll save are untouched.
- **v2 capture-aware sync** — `executeCaptureDownload` is already correct (no double-write).
- **Delete-from-glasses safety checks** — existing size validation in `mediaProcessingQueue` is untouched.
- **Data model** — no new fields added to `DownloadedFile` or `PhotoInfo`. The `provisional` flag considered during planning was intentionally dropped in favour of simplicity.
- **Navigation / routing** — gallery routes unchanged.

---

## Success Criteria

1. A sync of 20+ photos with image processing enabled results in **zero** photos missing from the gallery index.
2. Gallery displays photos in strict newest-first chronological order by capture time.
3. Sentry alert fires within 24 hours if any user experiences an unexplained photo count drop.
4. Sentry warning fires if orphan files are detected on startup.
5. No false alarms from user-initiated deletion, "Clear All", app reinstall, or burst-mode identical timestamps.
6. All ~29 automated tests pass (`bun test`), including the concurrent write serialization test that directly reproduces the original bug.
