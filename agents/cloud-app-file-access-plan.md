# Cloud-App File Access Plan

Status: RFC. Looking for maintainer feedback before any code lands.

## Motivating use case

I'm building **metra_reader**, a third-party MentraOS book reader: user
picks a `.txt` from their phone, the cloud backend paginates it, the
glasses display one page at a time, and the user navigates with button /
head / swipe / voice. Bookmarks and highlights persist server-side. It
works against the documented SDK today.

The wart is at the front door. Every book is a one-off file upload —
there's no notion of "the book I'm reading lives at this path on the
phone." Re-pick on every install. Re-pick to switch books. The cloud-side
library helps (we paginate once and remember progress), but it doesn't
help the user _get the file in_ in a way that survives.

A durable file handle would fix that for the reader. The same pattern
generalizes to other apps that need long-lived access to user-owned data:
audiobook players over a folder of mp3s, PDF readers reopening recents,
a dictation app watching a "voice memos" folder. Anywhere a third-party
app needs the user's files to persist across sessions and re-installs
without re-prompting on every cold start.

The API design that follows is what I'd want to build metra_reader
against — generalized so it covers the other apps too.

## Context

Cloud apps (third-party servers using `@mentra/sdk`) currently have no way to
read files from the user's phone. The `PermissionType` enum at
`cloud/packages/sdk/src/types/models.ts:34` covers seven things — microphone,
location, background location, calendar, camera, notifications (read + post)
— but nothing storage-related. Apps that want to operate on user-owned files
(books, audio, documents) have to ask the user to upload via a webview form
each time, which works for one-off interactions and not much else.

The closest existing surfaces are:

- `mobile/modules/miniapp/src/modules/storage.ts` — phone-local key-value
  store. Despite the name, it's not file I/O.
- `mobile/modules/miniapp/src/modules/permissions.ts` — manifest-declared
  permission introspection for miniapps. The file's preamble notes that
  "OS-level grant state and `request(...)` are deferred to a future round."

That deferred runtime-grant work and this proposal need to compose; the
design below is shaped to fit into it rather than fork around it.

## Goals

- Let a cloud app, **with explicit per-file user consent**, read bytes of a
  file the user picks from their phone.
- Support **persistent access**: once the user picks a file (or folder), the
  app can re-read it across sessions without re-prompting, until the user
  revokes or the app is uninstalled.
- Cross-platform parity between iOS and Android, with platform differences
  hidden behind a single SDK API.
- Compose with the upcoming runtime `request(...)` permission API rather
  than introducing a parallel approval flow.

## Non-goals

- General phone-filesystem browsing without user consent. The native picker
  is the only entry point; no `listFiles("/Downloads")`.
- Writing to user-owned phone storage. Apps already write into their own
  scoped namespace via SimpleStorage / cloud storage; blurring the read /
  write boundary muddies the security model.
- Replacing the webview `<input type="file">` flow. That's still the right
  answer for "user picks once, upload, done." This proposal is for apps
  that need durable handles.
- Glasses-side file storage. The glasses are storage-constrained and this
  is the wrong layer.

## Proposed API surface

### Manifest declaration

Add `STORAGE` to `PermissionType` at
`cloud/packages/sdk/src/types/models.ts`:

```typescript
export enum PermissionType {
  MICROPHONE = "MICROPHONE",
  LOCATION = "LOCATION",
  BACKGROUND_LOCATION = "BACKGROUND_LOCATION",
  CALENDAR = "CALENDAR",
  CAMERA = "CAMERA",
  NOTIFICATIONS = "NOTIFICATIONS",
  READ_NOTIFICATIONS = "READ_NOTIFICATIONS",
  POST_NOTIFICATIONS = "POST_NOTIFICATIONS",
  STORAGE = "STORAGE",
  ALL = "ALL",
}
```

App manifest sample:

```json
{
  "permissions": [
    {
      "type": "STORAGE",
      "description": "Read books you choose from your phone."
    }
  ]
}
```

### SDK runtime API

New `session.files` module on `AppSession`:

```typescript
interface FilesModule {
  pickFile(options?: PickFileOptions): Promise<PickedFile | null>
  pickFolder(options?: PickFolderOptions): Promise<PickedFolder | null>
  readFile(handle: FileHandle): Promise<Uint8Array>
  listFolder(handle: FolderHandle): Promise<FileEntry[]>
  release(handle: FileHandle | FolderHandle): Promise<void>
  listHandles(): Promise<StoredHandle[]>
}

interface PickFileOptions {
  accept?: string[]      // e.g. [".epub", ".pdf", "text/plain"]
  multiple?: false       // multi-pick deferred; single only in v1
}

interface PickedFile {
  handle: FileHandle     // opaque token, durable across sessions
  name: string
  size: number
  mimeType: string
  bytes?: Uint8Array     // inlined when small (<256KB); fetch via readFile otherwise
}

type FileHandle = string  // opaque, scoped to (userId, packageName)
```

`pickFile` resolves to `null` when the user cancels (distinct from rejecting
on error).

### Phone↔cloud↔app protocol

New message types in `cloud/packages/types/src/messages/`:

```typescript
// app → cloud → phone
interface FilePickRequest {
  type: "files:pick"
  requestId: string
  options: PickFileOptions
}

// phone → cloud → app
interface FilePickResult {
  type: "files:pick:result"
  requestId: string
  file: PickedFile | null      // null on user cancel
}

interface FileReadRequest {
  type: "files:read"
  requestId: string
  handle: FileHandle
  offset?: number
  length?: number              // for chunked reads of large files
}

interface FileReadResult {
  type: "files:read:result"
  requestId: string
  bytes: Uint8Array
  totalSize: number
  done: boolean
}

interface FileError {
  type: "files:error"
  requestId: string
  code: "REVOKED" | "NOT_FOUND" | "PERMISSION_DENIED" | "TOO_LARGE" | "IO_ERROR"
  message: string
}
```

Inline bytes from `pickFile` are capped (suggested 256 KB) so a typical
`.epub` or `.pdf` round-trip is one message; larger files are fetched via
chunked `files:read`.

## Implementation sketch

### iOS (`mobile/modules/core/ios/`)

- New `MentraFilesBridge` Expo native module.
- `pickFile`: present `UIDocumentPickerViewController` with the requested
  UTIs.
- On success: call `startAccessingSecurityScopedResource()` on the picked
  URL, create a security-scoped bookmark
  (`URL.bookmarkData(options: .withSecurityScope)`), base64-encode it, store
  in CoreData keyed by `(userId, packageName, handle)`.
- `readFile`: resolve handle → decode bookmark → `URL(resolvingBookmarkData:)`
  → read bytes inside the security scope, then
  `stopAccessingSecurityScopedResource()`.
- `release(handle)`: delete the bookmark row.
- Stale bookmark detection: `URL(resolvingBookmarkData:)` sets the
  `isStale` flag; we re-prompt the user (returning `REVOKED`).

### Android (`mobile/modules/core/android/`)

- New `MentraFilesBridge` native module.
- `pickFile`: launch `Intent.ACTION_OPEN_DOCUMENT` via
  `ActivityResultContracts.OpenDocument`. Filter by MIME types derived from
  `accept`.
- On success: call
  `contentResolver.takePersistableUriPermission(uri, FLAG_GRANT_READ_URI_PERMISSION)`
  so the grant survives device reboots. Store `(handle, uri.toString())` in
  Room.
- `readFile`: resolve handle → URI → `contentResolver.openInputStream(uri)`.
- `release(handle)`: call
  `contentResolver.releasePersistableUriPermission(uri, ...)` and delete the
  row.
- SAF on API 30+ removes the need for `READ_EXTERNAL_STORAGE` — grants are
  per-document.

### Cloud routing (`cloud/packages/cloud/`)

- New message handlers in `cloud/packages/cloud/src/services/messages/` (or
  wherever the existing camera / location handlers live; need to verify).
- Permission check: reject if `STORAGE` is not in the app's manifest before
  forwarding to the phone.
- Audit log every `files:pick` and `files:read` keyed by
  `(userId, packageName, handle)`. File access is the most sensitive
  surface this PR adds; opt-in observability matters.
- Cap per-request bytes (suggested 1 MB chunk) and apps' aggregate
  in-flight handles (suggested 50).

### SDK plumbing (`cloud/packages/sdk/src/`)

- Add `FilesModule` class under
  `cloud/packages/sdk/src/session/modules/files.ts`.
- Wire onto `AppSession.files` in
  `cloud/packages/sdk/src/app/session/index.ts`.
- Promise-based, using the existing request/response infrastructure in the
  WebSocket transport.

### Webview parity (optional, separate stage)

- Expose `window.mentra.files.pickFile()` and `readFile(handle)` in
  webviews via the existing webview↔phone bridge. Same handle format, same
  CoreData/Room rows.
- Lets a webview app and its backend share durable handles, instead of
  re-uploading every cold-start.

## Composition with planned runtime-grant API

`mobile/modules/miniapp/src/modules/permissions.ts` calls out a future
`request(...)` / `isGranted(...)` surface. STORAGE slots in naturally:

- Manifest declaration → `permissions.has("STORAGE") === true`
- `pickFile()` is itself the runtime request — the OS picker IS the consent
  dialog
- `permissions.isGranted("STORAGE")` would be true iff the user has ever
  granted at least one file handle that hasn't been revoked

So this PR does NOT need to wait on the runtime-grant work; it informs it.

## Staging plan

1. **Stage 0 — RFC (this doc).** Maintainer review.
2. **Stage 1 — Types only.** Add `STORAGE` to `PermissionType`, add the
   message type definitions in `cloud/packages/types/src/`. Mergeable
   independently once API is agreed.
3. **Stage 2 — iOS native + SDK.** End-to-end `pickFile` / `readFile` on
   iOS. Test app does single-file pick of an `.epub`.
4. **Stage 3 — Android native.** Mirror iOS. Behind a capabilities flag if
   we want to ship iOS-only first; otherwise gate Stage 2 from shipping
   until 3 lands.
5. **Stage 4 — Cloud audit logging + quotas.**
6. **Stage 5 — Settings UI.** "File access" screen in the mobile app
   listing per-app handles with revoke. Lands in
   `mobile/src/app/miniapps/settings/`.
7. **Stage 6 — Webview parity.** `window.mentra.files`.
8. **Stage 7 — Docs.** Update `docs/app-devs/core-concepts/permissions.md`
   and add `docs/app-devs/core-concepts/files.md`.

## Open questions

1. **Naming.** `STORAGE` is broad. `FILES` or `READ_FILES` might communicate
   intent better. The Android world says "storage" (Scoped Storage, SAF);
   iOS says "documents." Pick one and stick with it.
2. **Handle scope.** Per-app makes sense. Should a handle be shared across
   app reinstalls? Probably not — uninstall is the user's revoke gesture.
3. **Folder access on iOS.** `UIDocumentPickerViewController` does support
   folder selection (`asFolder` UTI), but the semantics around enumerating
   children in the background differ from Android SAF. Worth confirming
   parity before committing to `pickFolder`.
4. **Quotas.** 50 handles per app, 1 MB per chunk are guesses. Real
   numbers depend on what apps maintainers expect to ship.
5. **Chunked reads vs presigned uploads.** For large files (think 50 MB
   PDFs), shipping bytes through the WebSocket may be the wrong layer.
   An alternative: phone uploads to a cloud-hosted blob store, app gets a
   presigned URL. That's a separate design.
6. **Settings UI placement.** Per-app screens already exist for individual
   permissions; should file handles live there, or in a dedicated "File
   access" top-level entry?
7. **Notifications when a handle goes stale.** Push an event to the app
   (`session.events.onFileHandleRevoked`)? Or rely on `readFile` returning
   `REVOKED`?

## Out of scope (intentionally)

- Writing to user-owned phone files.
- Phone-to-phone file sharing.
- Glasses-side file storage / read.
- Cloud-mirrored library (phone uploads to MentraOS cloud bucket, apps
  read from there) — a different feature, worth its own RFC.
- Multi-file picks. Single-file is the v1 contract; the API leaves room
  (`multiple?: false` in `PickFileOptions`) to extend.

## What lands in the first PR (if RFC accepted)

Per Stage 1 above: a single PR adding

- `STORAGE` to the `PermissionType` enum.
- `FilePickRequest` / `FilePickResult` / `FileReadRequest` /
  `FileReadResult` / `FileError` message types in
  `cloud/packages/types/src/messages/`.
- Stub `FilesModule` in `cloud/packages/sdk/src/session/modules/files.ts`
  that throws "not implemented yet" — so apps can wire against the API
  while native work proceeds.
- Doc update marking STORAGE as "type defined, implementation in
  progress."

No native code in this PR; that's Stage 2+.
