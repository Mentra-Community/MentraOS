# MiniApp Service

**Status:** First developer registry slice implemented.

Cloud Core owns miniapp package identity, release metadata, installable release
bundles, store media metadata, and the future admin review/preinstalled registry
workflow. The first vertical slice supports Console2 and the CLI:

1. Reserve a MiniApp package name.
2. Build and pack a miniapp locally.
3. Upload the installable release bundle zip through the CLI.
4. Show the resulting MiniApp and MiniAppRelease rows in Console2.

Source:

- `packages/core/src/models/miniapp.model.ts`
- `packages/core/src/models/miniapp-release.model.ts`
- `packages/core/src/models/miniapp-asset.model.ts`
- `packages/core/src/services/miniapps/miniapp.service.ts`
- `packages/core/src/api/console/cli-auth.api.ts`

## Concepts

### MiniApp

Stable package/product identity.

```ts
interface MiniApp {
  orgId: string
  packageName: string
  displayName: string
  description?: string | null
  status: "active" | "archived" | "suspended"
  activeReleaseId?: string | null
}
```

Review state does not live here. A MiniApp can keep serving an older published
release while a newer release is draft, in review, rejected, or suspended.

Package names must live under the developer org's package prefix. In dev the
default prefix is `com.mentra`; production should configure prefixes per WorkOS
org or enterprise org record. Core enforces this for both Console2 and CLI
requests, so UI prefix rendering is not trusted as the only guard.

### MiniAppRelease

Versioned lifecycle unit.

```ts
interface MiniAppRelease {
  orgId: string
  miniAppId: string
  packageName: string
  version: string
  status: "draft" | "submitted" | "in_review" | "accepted" | "rejected" | "published" | "suspended"
  manifest: Record<string, unknown>
  releaseBundleAssetId?: string | null
  bundleSha256?: string | null
  bundleSizeBytes?: number | null
}
```

The release bundle is the installable zip produced by the miniapp packer. Today
`mentra publish` uploads it directly to Core as base64 for local/dev simplicity.
The storage model is already separate so this can move to presigned uploads
without changing the data model.

### MiniAppAsset

Metadata for bytes in Core storage.

```ts
interface MiniAppAsset {
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
}
```

There is no separate `type` field. `role` says why the asset exists, and
`contentType` says what the bytes are.

## Release bundle format

Current local miniapp tooling produces:

```txt
build/<packageName>-<version>.zip
```

The phone installs this zip as a bundle. The zip root must contain
`miniapp.json`; two-layer miniapps also include paths such as:

```txt
background/index.js
ui/index.html
ui/assets/*
icon.png
```

Use "release bundle" for this zip. Use "background JS bundle" only for the
internal `background/index.js` file inside the zip.

## Console API

```txt
GET    /api/console/apps
POST   /api/console/apps
DELETE /api/console/apps/:packageName
GET    /api/console/apps/:packageName/releases
POST   /api/console/apps/:packageName/releases
```

All routes accept the Console browser session cookie or the CLI bearer token.

## Related specs

- [`../../011-miniapp-registry/`](../../011-miniapp-registry/)
- [`../../012-mentra-cli-v2/`](../../012-mentra-cli-v2/)
- [`preinstalled-local-miniapps.md`](./preinstalled-local-miniapps.md)
