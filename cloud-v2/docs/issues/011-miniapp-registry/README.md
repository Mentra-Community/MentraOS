# 011 - Miniapp Registry and Auto Update

**Status:** Developer registry, release submit/review/publish, admin
preinstall registry, mobile startup reconciliation, and device-side bundle hash
verification are implemented locally. Store listing media, richer admin roles,
and presigned uploads are next.

## Problem

Cloud v2 needs one source of truth for miniapp package identity, versioned
release bundles, store media, review state, and preinstalled defaults. The old
cloud had too many storage paths and overlapping concepts. The rewrite should
keep those boundaries crisp from the start.

## Goals

- Reserve globally unique miniapp package names per developer org.
- Store immutable release bundle metadata and hashes in Cloud Core.
- Route all bundle and media bytes through the Core storage service.
- Keep release review/publish state on the release, not on the MiniApp.
- Let Console2 and `@mentra/cli` share the same Core API.
- Later, let mobile reconcile installed/preinstalled miniapps from a signed
  registry response.

## Non-goals

- Do not rebuild the Store catalog UI in this issue.
- Do not let developers publish directly into the preinstalled registry.
- Do not duplicate S3/R2/local storage provider code inside miniapp-service.
- Do not require the enterprise portal before Mentra-default preinstalled
  registry works.

## Core Concepts

### MiniApp

Stable package/product identity.

```ts
interface MiniApp {
  id: string
  orgId: string
  packageName: string
  displayName: string
  description?: string | null
  status: "active" | "archived" | "suspended"
  activeReleaseId?: string | null
  createdAt: string
  updatedAt: string
}
```

`packageName` is claimed once. Review status does not live on the MiniApp
because a MiniApp can have one release published while another release is in
review or rejected.

Package names must start with the developer org's package prefix. For the
Mentra dev org this is currently `com.mentra`, so package names look like
`com.mentra.local-captions` or `com.mentra.example`. Console2 renders the prefix
as non-editable text, and Core still enforces it for CLI/API callers.

Developer orgs are created during Console2 onboarding. Each org claims one
globally unique package prefix, stored in Cloud Core. Prefixes have independent
verification state:

```ts
packagePrefixStatus: "unverified" | "verified" | "rejected"
```

Reserved prefixes such as `com.mentra` are policy-protected so a random
developer cannot claim them. Verification is not the same as reservation:
unverified prefixes are allowed for development, while public store review can
later require proof of domain or brand ownership. Once an org has active
miniapps, prefix changes are rejected because they would break installed
package identity.

### MiniAppRelease

Versioned artifact and review lifecycle.

```ts
interface MiniAppRelease {
  id: string
  orgId: string
  miniAppId: string
  packageName: string
  version: string
  status: "draft" | "submitted" | "in_review" | "accepted" | "rejected" | "published" | "suspended"
  manifest: Record<string, unknown>
  releaseBundleAssetId?: string | null
  bundleSha256?: string | null
  bundleSizeBytes?: number | null
  submittedAt?: string | null
  reviewedAt?: string | null
  publishedAt?: string | null
  reviewedBy?: string | null
  reviewNotes?: string | null
  createdAt: string
  updatedAt: string
}
```

The release bundle is the installable zip produced by the miniapp tooling:

```txt
build/<packageName>-<version>.zip
```

The phone downloads and unzips this bundle. The zip root contains
`miniapp.json`, and two-layer miniapps include entries like
`background/index.js`, `ui/index.html`, UI chunks/assets, and `icon.png`.

### MiniAppAsset

Metadata for bytes stored by Core storage.

```ts
interface MiniAppAsset {
  id: string
  orgId: string
  miniAppId: string
  releaseId?: string | null
  role: "release_bundle" | "store_icon" | "store_cover" | "gallery_screenshot" | "promo_video"
  storageKey: string
  fileName: string
  contentType: string
  sizeBytes: number
  sha256: string
  width?: number | null
  height?: number | null
  durationMs?: number | null
  sortOrder?: number | null
  createdAt: string
}
```

`role` is why the asset exists. `contentType` is what the bytes are. We do not
need a third broad `type` field.

Release artifacts use:

```txt
role=release_bundle
contentType=application/zip
fileName=bundle.zip or <packageName>-<version>.zip
```

Store listing media uses the same table with roles such as `store_icon`,
`store_cover`, `gallery_screenshot`, and `promo_video`.

## Storage Service Dependency

Miniapp registry must not talk directly to S3, R2, or local files. Core owns the
provider wrapper:

```ts
interface StorageProvider {
  putObject(input: PutObjectInput): Promise<StoredObject>
  getObject(storageKey: string): Promise<Uint8Array>
  deleteObject(storageKey: string): Promise<void>
}
```

The current implementation supports local file storage for development. R2/S3
providers should add presigned upload/download while preserving the same
metadata model.

## Current Developer API

```txt
GET    /api/console/apps
POST   /api/console/apps
DELETE /api/console/apps/:packageName
GET    /api/console/apps/:packageName/releases
POST   /api/console/apps/:packageName/releases
POST   /api/console/apps/:packageName/releases/:releaseId/submit
```

`POST /releases` currently accepts a base64 bundle zip for local/dev E2E. The
next storage iteration should switch this to:

```txt
POST /api/console/apps/:packageName/releases/upload-intents
PUT  <presigned upload URL>
POST /api/console/apps/:packageName/releases/:releaseId/finalize
```

## CLI Contract

```txt
mentra login
mentra miniapps list
mentra miniapps create com.mentra.myapp --name "My App"
mentra releases list com.mentra.myapp
mentra publish
```

`mentra publish` runs from a miniapp folder, reads `miniapp.json`, runs the
project build/pack scripts, creates the MiniApp record if needed, uploads the
release bundle zip to Core, then submits that release for admin review.

## Device Contract

Implemented mobile registry endpoint:

```txt
GET /api/client/miniapps/registry
Authorization: Bearer <cloud-core access token>
```

Response:

```ts
interface ClientMiniappRegistry {
  generatedAt: string
  entries: ClientMiniappRegistryEntry[]
}

interface ClientMiniappRegistryEntry {
  packageName: string
  version: string
  bundleUrl: string
  bundleSha256: string
  required: boolean
  installPolicy: "install_once" | "keep_updated" | "mandatory"
  channel: string
  minMobileVersion?: string
  maxMobileVersion?: string
  tenantId?: string
}
```

Mobile owns local reconciliation in
`mobile/src/services/miniapps/preinstalledMiniappSync.ts`, called from
`MantleManager.initMiniapps()` after bundled miniapps install:

1. Fetch registry after auth and periodically after refresh.
2. Install missing `install_once` entries only when no version is already
   installed.
3. Upgrade `keep_updated` and `mandatory` entries when the target version is
   missing.
4. Never delete an installed miniapp solely because it disappeared from a bad
   registry response.
5. Download the bundle to a local cache path, verify `bundleSha256` before
   unzipping, and keep the previous installed version on mismatch.

## Admin Review and Preinstalled Registry

Admin review should operate on MiniAppRelease rows. The preinstalled registry is
admin-controlled policy layered on top of accepted/published releases.

```ts
interface PreinstalledRegistry {
  id: string
  name: string
  environment: "debug" | "dev" | "staging" | "prod"
  tenantId?: string
  status: "draft" | "active" | "archived"
  activeRevisionId?: string
}

interface PreinstalledRegistryEntry {
  id: string
  registryRevisionId: string
  miniAppId: string
  releaseId: string
  required: boolean
  installPolicy: "install_once" | "keep_updated" | "mandatory"
  minMobileVersion?: string
  maxMobileVersion?: string
  priority: number
}
```

Implemented admin preinstall API:

```txt
GET  /api/admin/me
GET  /api/admin/submissions
POST /api/admin/submissions/:releaseId/approve
POST /api/admin/submissions/:releaseId/reject
POST /api/admin/submissions/:releaseId/publish
GET  /api/admin/preinstalled/registries
POST /api/admin/preinstalled/registries
GET  /api/admin/preinstalled/releases
GET  /api/admin/preinstalled/registries/:registryId/revisions
POST /api/admin/preinstalled/registries/:registryId/revisions
POST /api/admin/preinstalled/registries/:registryId/revisions/:revisionId/promote
GET  /api/admin/audit-log
```

Admin auth reuses the Console2 WorkOS sealed session cookie. Access is allowed
for explicit `CLOUD_CORE_ADMIN_EMAILS` or email domains from
`CLOUD_CORE_ADMIN_EMAIL_DOMAINS`, defaulting to `mentraglass.com` for local
internal builds. This is a first slice; role-based internal admin permissions
are tracked in issue 015.

The client registry lookup prefers an OEM-specific active registry and falls
back to the default registry (`tenantId: null`) for the same environment.

Implemented admin UI:

```txt
cloud-v2/websites/admin
bun run dev:admin   # http://localhost:5174
```

It signs in through the same Mentra/WorkOS login, reviews submitted release
bundles, publishes accepted releases, and promotes selected release bundles to
the active preinstall registry revision.

Registry changes are revisioned so a bad default set can be rolled back and
audited.

## Verification

Current local checks:

```txt
bun test tests/miniapp-release-lifecycle.integration.test.ts
```

The integration test creates a miniapp, uploads a release bundle, submits it,
approves it as an admin, publishes it, and verifies the MiniApp points at the
published active release.
