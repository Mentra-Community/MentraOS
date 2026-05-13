# Miniapp Store Backend Plan

Backend design for the miniapp developer console + store pipeline. Frontend work is out of scope here — this doc is API shape + data model + service boundaries so tickets can be cut.

Targets Linear issues **OS-1307** (console support) and **OS-1309** (store install flow). The store user-facing frontend stays ~99% the same; miniapps appear alongside cloud apps on the store, differentiated by a `kind` field.

---

## Current state (baseline)

Cloud apps live in one MongoDB `apps` collection. Dev flow today:

1. Developer fills a form in console → `POST /api/console/apps` → `console.apps.service.createApp()` at `cloud/packages/cloud/src/services/console/console.apps.service.ts:182`
2. Validates uniqueness, resolves org, mints API key, stores record
3. `POST /api/console/apps/:packageName/publish` flips `appStoreStatus` to `PUBLISHED`
4. Store reads `/api/store/published-apps`, filters on the flag

File upload already exists: preview images for cloud apps go through `POST /api/dev/apps/:packageName/image` → `storageService.uploadImageAndReplace()` at `cloud/packages/cloud/src/api/hono/routes/developer.routes.ts:731`. That service wraps `R2StorageService` at `cloud/packages/cloud/src/services/storage/r2-storage.service.ts`, which is already fully configured against the `mentra-store` R2 bucket with a public CDN at `https://mentra-store-cdn.mentraglass.com`.

So R2 is live. We use it. No new bucket setup needed for assets.

---

## Decisions

### Separate collection, not a discriminator on `apps`

Miniapps and cloud apps are different enough that a `kind` field on the existing model would create a mess of optional fields and conditional logic. Cleaner split:

- Keep `apps` as-is for cloud apps
- New `miniapps` collection for miniapp records

Shared concepts (org ownership, store status, preview images, permissions, hardware requirements) are duplicated in both schemas. That's fine — they diverge over time anyway, and the store frontend does a cheap union-fetch across both collections to render the listing.

This also sets up clean separation for the eventual cloud rewrite — miniapps land in new files, cloud apps live in the old ones, and the rewrite can migrate one collection at a time.

### Register first, then upload versions (like Play Store / App Store)

Developer flow:

1. Developer registers a miniapp in the console — picks `packageName`, done. This creates a `miniapps` record with no versions, `appStoreStatus: DEVELOPMENT`, not visible anywhere except the dev's own console.
2. Developer builds the miniapp locally, `mentra-miniapp pack` produces a ZIP.
3. Developer uploads the ZIP to the registered miniapp → creates the first version entry. `version`, `permissions`, `hardwareRequirements`, `name`, `description` all come from the `miniapp.json` inside the ZIP.
4. Subsequent version uploads append to `versions[]` on the same record.

Store page is **not visible** (not even via share link) until at least one version exists. `currentVersion` is null until then.

The console validates `packageName` uniqueness at registration time, so devs find out immediately if a name is taken.

### `packageName` is the immutable primary key

The `miniapp.json` inside the ZIP has a `packageName` — that's the identifier forever. On version upload, we verify the ZIP's `packageName` matches the registered miniapp's `packageName` and reject mismatches. If a developer wants to rename, they register a new miniapp.

`name` (human-readable) can change freely across versions — it's just metadata.

### Storage layout (two buckets, one existing + one new)

Existing buckets (from `cloud/.env.example`):

- **`mentra-store`** — public via CDN `mentra-store-cdn.mentraglass.com`. Holds `mini_app_assets/...` (cloud-app icons + preview images). Wrapped by `R2StorageService` at `cloud/packages/cloud/src/services/storage/r2-storage.service.ts`.
- **`mentra-incidents`** — private, no CDN mapping. Accessed via API proxy only. Wrapped by `IncidentStorageService` at `cloud/packages/cloud/src/services/storage/incident-storage.service.ts`. This is the precedent for "private R2 bucket in this codebase."

Plan:

- **Icons + preview images**: reuse the existing **`mentra-store`** public bucket under the `mini_app_assets/...` prefix — identical pattern to how cloud-app images work today, served via the existing CDN. No new bucket.
- **ZIP bundles**: new **private** bucket `mentra-miniapp-bundles` (name TBD; matches the `mentra-incidents` precedent). No CDN mapping. Signed URLs only, via the R2 S3 API endpoint.

Object key structure:

- Bundles (in `mentra-miniapp-bundles`, private): `bundles/{packageName}/{version}.zip`
- Icons (in `mentra-store`, public CDN): `mini_app_assets/{packageName}/icon-{timestamp}.{ext}` — uses existing `uploadImageAndReplace` pattern for automatic old-version cleanup
- Preview images (in `mentra-store`, public CDN): `mini_app_assets/{packageName}/preview-{timestamp}-{filename}` — identical path shape to cloud-app preview images today

New env vars (add to `cloud/.env.example`):

- `R2_MINIAPP_BUNDLES_BUCKET=mentra-miniapp-bundles` (or whatever you pick on the Cloudflare side)

Existing R2 creds (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) are reused — same account, just a different bucket. No new Cloudflare account setup.

New service: `MiniappBundleStorageService` modeled on `IncidentStorageService` (private-bucket pattern, lazy init, no CDN). For the public icon + preview image writes, call into the existing `R2StorageService.uploadImageAndReplace()` — no need to duplicate that logic.

### Signed bundle downloads (Cloudflare-first)

ZIPs are **not public**. Every download goes through cloud-minted signed URLs. We already use Cloudflare for R2 and for streaming (`CloudflareStreamService`) — stay on that stack.

Implementation:

- `@aws-sdk/s3-request-presigner` with `getSignedUrl` — standard S3-compatible signing, works against R2's endpoint (already used by `R2StorageService`).
- All signing is server-side. The phone never sees R2 credentials.
- Download flow:
  - Developer viewing their own miniapp in console: gets a signed URL (7-day TTL) they can copy for their own install/testing.
  - Store install flow: phone hits `POST /api/client/miniapps/:packageName/install-url` → cloud checks authorization (see sharing model) → mints a fresh short-TTL (5 min) signed URL → phone passes to `Composer.installFromUrl()`.
  - Admin review: bypass endpoint for any version.

### Store visibility (3 states) + sharing policy (orthogonal)

**Store status** — drives where the miniapp appears:

- `DEVELOPMENT` (default) — only org members can see the store page in console
- `SUBMITTED` — still only org members, but visible to admins in review queue
- `PUBLISHED` — on the public store, visible to everyone
- `REJECTED` — admin-rejected, back to dev-only (with review notes)

**Sharing policy** — drives who can access the store page + download the bundle when **not published**:

- `PRIVATE` (default) — only org members
- `PUBLIC_LINK` — anyone with the share link can view the store page and install
- `ALLOWLIST` — only specified users (start with email matching, schema supports extending to userIds later)

Variable naming: use **`ALLOWLIST`** not `EMAIL_ALLOWLIST`. The implementation will match on email for now, but the field name stays neutral so adding userId-matching later is additive.

Variable naming: use **`PUBLIC_LINK`** not `LINK`, for clarity about what it does.

Once `PUBLISHED`, the sharing policy is bypassed — everyone can see the store page and install. Sharing only matters pre-publish.

**Share link semantics**: a miniapp's store page has a canonical URL derived from `packageName` (e.g. `https://store.mentra.glass/app/com.foo.bar`). There's no per-share-invite URL. "Sharing" means toggling the access policy on the miniapp itself:

- If policy is `PUBLIC_LINK`, anyone hitting the store page URL can view it and install.
- If policy is `ALLOWLIST`, only authenticated users matching an entry can view the store page or install — both routes (page fetch + install-url mint) check the policy.
- If policy is `PRIVATE`, only org members get access.

No one-time-use links. No share-id rotation. This is simpler than the Google-Drive link-sharing model and matches how the dev thinks about it.

**Implementation cost**: small. It's one field on the miniapp record + an `allowlist: string[]` subfield + the authorization branch on the install-url endpoint + the same authorization branch on store-page lookup.

### Icon: extracted from ZIP on version upload

On every version upload:

1. Extract the icon from the ZIP (location specified in `miniapp.json`, default `icon.png`)
2. Upload via the existing `uploadImageAndReplace` pattern — replaces previous icon key, gets a new public CDN URL
3. Store URL on the miniapp record (not per-version — only the current icon matters)

The ZIP is source of truth; the separate public icon URL exists for UI perf.

### Admins can download ZIPs for review

Admin endpoint at `/api/admin/miniapps/:packageName/bundle-url?version=X` mints a signed URL regardless of sharing policy. Supports the submission-review flow.

### Rate limiting

Upload endpoints (both registration and version upload): **20 uploads per hour per user**. Implementation: middleware on the upload routes; reuse whatever rate-limiter the codebase already has (check existing middleware).

### Size limits

Max ZIP size: **100 MB**. Env var (`MINIAPP_MAX_BUNDLE_BYTES`) so it's tunable without a redeploy. Reject at the multipart parsing layer, not after full upload.

### Auto-update on phones

Phones always install the latest version. No pinning, no user-facing version selector. When a new version is uploaded, installed phones pick it up on next check (mobile-side polling or push; exact mechanism out of scope for this doc, but the backend exposes `currentVersion` + `manifestSnapshot` under the current version, which is enough for the phone to diff).

The schema keeps `versions[]` + `currentVersion` as a pointer. Console UI shows the version history (developers need to see what they've uploaded). Store UI and phones only ever see `currentVersion`.

### Permission re-prompting on version updates: already works for free

Verified: `mobile/src/utils/PermissionsUtils.tsx:736` (`checkPermissionsUI`) reads `app.permissions` at app-start time and prompts for any not-yet-granted OS permission. Since the miniapp record always serves the current version's `manifestSnapshot.permissions`, and the phone reads it fresh on launch, a v1.1.0 that adds `CAMERA` will automatically trigger the OS permission prompt the next time the user opens the app. Nothing backend-side needed.

---

## Data model

### New collection: `miniapps`

```ts
interface MiniappDocument {
  _id: ObjectId

  // Identity (immutable after registration)
  packageName: string           // PK, unique index
  organizationId: ObjectId      // FK to organizations (miniapps belong to orgs, not users)
  createdAt: Date
  createdBy: ObjectId           // FK to users — who registered it

  // Version history
  currentVersion: string | null // null until first upload; semver matching an entry in versions[]
  versions: Array<{
    version: string             // semver from miniapp.json
    bundleKey: string           // R2 object key, e.g. "miniapp_bundles/com.foo/1.2.0.zip"
    bundleSizeBytes: number
    bundleSha256: string        // for integrity check on phone
    uploadedAt: Date
    uploadedBy: ObjectId
    manifestSnapshot: {         // parsed miniapp.json for this version
      packageName: string
      version: string
      name: string
      description?: string
      permissions: PermissionDecl[]
      hardwareRequirements: HardwareRequirement[]
    }
  }>

  // Store listing metadata (editable independent of versions)
  displayName: string           // defaults to latest manifest.name; dev can override
  description: string           // defaults to latest manifest.description; dev can override
  iconPublicUrl: string | null  // CDN URL; null until first version uploaded
  previewImages: Array<{
    url: string                 // public CDN URL
    imageId: string             // R2 key, for deletion
    orientation: "landscape" | "portrait"
    order: number
  }>
  categories?: string[]
  appType: "standard" | "background"

  // Store status
  appStoreStatus: "DEVELOPMENT" | "SUBMITTED" | "REJECTED" | "PUBLISHED"
  submittedAt?: Date
  publishedAt?: Date
  reviewerNotes?: string        // admin feedback on rejection

  // Sharing policy (orthogonal to store status; only matters when !PUBLISHED)
  sharing: {
    policy: "PRIVATE" | "PUBLIC_LINK" | "ALLOWLIST"
    allowlist?: string[]        // emails for now, userIds later — only when policy=ALLOWLIST
  }

  updatedAt: Date
}
```

**Indexes:**

- `{ packageName: 1 }` unique
- `{ organizationId: 1, updatedAt: -1 }` — "list miniapps for this org"
- `{ appStoreStatus: 1, publishedAt: -1 }` — store listing + admin review queue

### No changes to existing `apps` collection

Cloud apps keep their schema. Store frontend fetches from both collections and unions at query time.

---

## API endpoints

Auth for all `/api/console/miniapps/*` endpoints: standard developer JWT (same as `/api/console/apps`). Authorization: caller must be an org member with the necessary role — **same permission model as cloud apps** (org admin for destructive operations, org member for uploads). No per-miniapp API keys.

### `POST /api/console/miniapps`

Register a miniapp. No upload, no version yet. Just reserves the `packageName`.

**Body**:

```json
{
  "packageName": "com.example.myapp",
  "displayName": "My App",
  "description": "...",
  "orgId": "optional; defaults to caller's default org"
}
```

**Steps**:

1. Validate `packageName` format + uniqueness
2. Verify caller has upload rights in the org
3. Insert `miniapps` document with `versions: []`, `currentVersion: null`, `appStoreStatus: "DEVELOPMENT"`, `sharing: {policy: "PRIVATE"}`
4. Return record

### `POST /api/console/miniapps/:packageName/versions`

Upload a new version ZIP. Requires caller has upload rights in the miniapp's org.

**Body**: `multipart/form-data` with `file`.

**Steps**:

1. Load miniapp, verify org membership
2. Extract + validate ZIP's `miniapp.json` using the shared validator (see "CLI validator move" below)
3. Verify `packageName` in manifest matches URL param
4. Verify `version` doesn't already exist in `versions[]`
5. Enforce 100 MB size limit
6. Upload ZIP → `miniapp_bundles/{packageName}/{version}.zip`
7. Extract icon from ZIP, upload via `uploadImageAndReplace` pattern, update `iconPublicUrl`
8. Append to `versions[]`, update `currentVersion` pointer
9. If this is the first version and `displayName`/`description` were defaulted at registration, refresh them from the manifest
10. Return updated record

### `GET /api/console/miniapps`

List miniapps for the authenticated developer's orgs.

**Query**: `?orgId=...` (optional filter)

**Response**: array of miniapp records (summary — omits full `versions[]`)

### `GET /api/console/miniapps/:packageName`

Full detail including full version history.

### `PUT /api/console/miniapps/:packageName`

Update store-listing metadata only. Rejects edits to fields sourced from `miniapp.json` (packageName, version, permissions, hardwareRequirements).

**Body**:

```json
{
  "displayName": "...",
  "description": "...",
  "categories": ["productivity"]
}
```

Preview images go through separate endpoints.

### `POST /api/console/miniapps/:packageName/preview-images`

Copy the logic from cloud apps (`POST /api/dev/apps/:packageName/image` at `developer.routes.ts:731`) into a new miniapp handler that writes into the miniapp record instead of the app record. Per the rewrite plan, we don't share code across app types — clean copy.

**Body**: `multipart/form-data` with `file`, `orientation`, `order`.

### `DELETE /api/console/miniapps/:packageName/preview-images/:index`

Remove a preview image (deletes the R2 object and the array entry).

### `POST /api/console/miniapps/:packageName/submit`

`DEVELOPMENT` → `SUBMITTED`. Requires at least one version uploaded. Sets `submittedAt`. Appears in admin queue.

### `POST /api/console/miniapps/:packageName/withdraw`

`SUBMITTED` → `DEVELOPMENT`. Developer-initiated.

### `PUT /api/console/miniapps/:packageName/sharing`

Update the sharing policy.

**Body**:

```json
{
  "policy": "PRIVATE" | "PUBLIC_LINK" | "ALLOWLIST",
  "allowlist": ["user@example.com", "..."]   // required when policy=ALLOWLIST
}
```

### `POST /api/admin/miniapps/:packageName/publish`

**Admin only.** `SUBMITTED` → `PUBLISHED`. Sets `publishedAt`. Visible in the public store.

### `POST /api/admin/miniapps/:packageName/reject`

**Admin only.** `SUBMITTED` → `REJECTED`. Body: `{ notes: string }` — saved on record, shown to developer.

### `POST /api/admin/miniapps/:packageName/unpublish`

**Admin only.** `PUBLISHED` → `DEVELOPMENT`. Removes from store listing. **Does not uninstall from devices** — document this clearly in admin UI.

### `GET /api/admin/miniapps/queue`

**Admin only.** Lists `SUBMITTED` miniapps for review.

### `GET /api/admin/miniapps/:packageName/bundle-url?version=X`

**Admin only.** Returns a short-TTL signed URL (15 min) to download any version's ZIP for review. Bypasses sharing policy.

### Bundle download — client path

### `POST /api/client/miniapps/:packageName/install-url`

Called by the phone's Composer when installing.

**Body**: (empty — no shareId, since there are no per-share links)

**Authorization**:

- If `appStoreStatus === "PUBLISHED"` → allow
- Else if caller's org matches the miniapp's `organizationId` → allow
- Else if `sharing.policy === "PUBLIC_LINK"` → allow (any authenticated user)
- Else if `sharing.policy === "ALLOWLIST"` and caller's email matches `sharing.allowlist` → allow
- Else → 403

**Response**:

```json
{
  "success": true,
  "data": {
    "version": "1.2.0",
    "bundleUrl": "https://<account>.r2.cloudflarestorage.com/mentra-store/...?X-Amz-...",
    "expiresAt": "2026-04-23T12:30:00Z",
    "bundleSha256": "...",
    "bundleSizeBytes": 123456
  }
}
```

Phone verifies `bundleSha256` after download.

### `GET /api/client/miniapps/:packageName`

Returns store-page data (display name, description, icon URL, preview images, permissions, hardware requirements — from the current version's `manifestSnapshot`). Same authorization as `install-url`: PUBLISHED bypasses auth; otherwise check org membership / PUBLIC_LINK / ALLOWLIST. This gates **both** the store page view and the install.

### Store listing endpoint

### `GET /api/store/published-apps`

Existing endpoint. Modify to union `apps` (where `appStoreStatus: PUBLISHED`) with `miniapps` (where `appStoreStatus: PUBLISHED`). Items carry a `kind: "cloud" | "miniapp"` field so the store frontend can dispatch install differently.

---

## Service layout

New file: `cloud/packages/cloud/src/services/console/console.miniapps.service.ts`

```
registerMiniapp(userId, {packageName, displayName, description, orgId?})
uploadMiniappVersion(userId, packageName, zipBuffer)
listMiniapps(userId, orgId?)
getMiniapp(userId, packageName)
updateMiniappMetadata(userId, packageName, patch)
addPreviewImage(userId, packageName, imageBuffer, orientation, order)
deletePreviewImage(userId, packageName, index)
submitMiniapp(userId, packageName)
withdrawMiniapp(userId, packageName)
updateSharing(userId, packageName, {policy, allowlist?})
mintInstallUrl(callerUserId, packageName) → authorization + signed URL
getStorePage(callerUserId, packageName) → authorization + view data
```

New file: `cloud/packages/cloud/src/services/admin/admin.miniapps.service.ts`

```
listReviewQueue()
publishMiniapp(adminUserId, packageName)
rejectMiniapp(adminUserId, packageName, notes)
unpublishMiniapp(adminUserId, packageName)
adminBundleUrl(adminUserId, packageName, version) → signed URL, any sharing policy
```

New file: `cloud/packages/cloud/src/services/storage/miniapp-bundle-storage.service.ts`

Private-bucket service for ZIP bundles. Modeled on `IncidentStorageService` (lazy init, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`). Methods:

```
putBundle(packageName, version, buffer, sha256) → bundleKey
getSignedBundleUrl(bundleKey, ttlSeconds) → URL
deleteBundle(bundleKey)
```

Icon and preview-image writes reuse the existing `R2StorageService.uploadImageAndReplace()` — the pattern already handles orgId scoping, timestamp keys, and old-version cleanup. No new service needed for public assets.

No local-disk fallback — R2 is already live.

### Shared manifest validator

Move the validator from `sdk/miniapp-cli/src/manifest.ts:68` into a shared package. Candidate homes:

- **`@mentra/miniapp`** — most natural semantically (the SDK defines the manifest shape)
- **`@mentra/utils`** — easier if `@mentra/miniapp` can't take on a validation dep

Either way: one function, imported by both the CLI and the cloud upload endpoint. No fork.

---

## Ordering / ticket breakdown

Suggested slicing (roughly in execution order):

1. **Move CLI manifest validator into shared package.** Extract from `sdk/miniapp-cli/src/manifest.ts:68`, publish in `@mentra/miniapp` or `@mentra/utils`. CLI imports from there. Prereq for everything else.
2. **Create `mentra-miniapp-bundles` private R2 bucket + `MiniappBundleStorageService`.** New bucket on the existing Cloudflare account, no CDN mapping. Service modeled on `IncidentStorageService` (private-bucket precedent), adds signed-URL support via `@aws-sdk/s3-request-presigner`. Icons + preview images reuse existing `R2StorageService`.
3. **`miniapps` collection + model.** Schema, indexes. No routes yet.
4. **`POST /miniapps` registration endpoint.** Reserve packageName, create empty record.
5. **`POST /miniapps/:packageName/versions` upload.** Validate, store ZIP, extract icon, update record. At this point dev can register + upload.
6. **`GET /miniapps` + `GET /:packageName` + `PUT /:packageName`.** List, detail, metadata edit.
7. **Preview image endpoints.** Copy from cloud-app logic into new miniapp handlers.
8. **Submit/withdraw/admin publish/admin reject/admin unpublish.** State machine. Reuse admin review UI patterns.
9. **Sharing endpoint (`PUT /:packageName/sharing`) + `PRIVATE` / `PUBLIC_LINK` / `ALLOWLIST` authorization logic on install-url and store-page endpoints.**
10. **`POST /client/miniapps/:packageName/install-url` + `GET /client/miniapps/:packageName` (store page).** End-to-end install from a registered, version-uploaded, shared miniapp to a phone. This is the internal-validation milestone.
11. **`/api/store/published-apps` union.** Cloud apps + published miniapps coexist on the public store.
12. **Admin ZIP download endpoint.** Supports review flow.
13. **Rate limiting + size limits.** Middleware on upload endpoints; 20/hr, 100 MB.

---

## Open questions / notes

- **Org transfers.** Miniapps belong to orgs, not users. Same org-transfer rules as cloud apps apply (miniapp stays with the org when a user leaves).
- **Version updates on phones.** Phone auto-updates to latest — the schema supports history, but the update mechanism (polling vs. push) is a mobile-side design, out of scope here.
- **Permission re-prompting on upgrades.** Verified: `mobile/src/utils/PermissionsUtils.tsx:736` reads `app.permissions` fresh at app-start. Since the record always serves the current version's `manifestSnapshot`, adding a new permission in a new version triggers the OS prompt automatically. No backend work needed.
- **CDN caching on icons.** Icons use timestamp-in-key pattern already used by cloud apps, so updates don't hit stale caches. No new work.
- **Eventual cloud rewrite.** Per the plan, cloud will be rewritten soon. Miniapps going into their own collection + their own service files + their own routes (rather than extending the existing app code) means that rewrite can migrate one concept at a time.
