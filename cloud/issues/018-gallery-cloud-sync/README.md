# Gallery Cloud Sync

Smart glasses upload photos/videos to cloud; mobile client syncs them down later.

## Documents

- **gallery-sync-spec.md** - Problem, goals, constraints
- **gallery-sync-architecture.md** - Technical design

## Quick Context

**Current**: No gallery sync exists. Photos/videos captured on glasses stay on glasses or require manual transfer.

**Proposed**: Glasses upload media to cloud storage via existing JWT auth, mobile app fetches pending items with download URLs, then marks as synced (cloud deletes).

The smart glasses (ASG) receive the user's auth token from the mobile app during pairing. From the cloud's perspective, requests from glasses look identical to requests from mobile - same JWT auth.

Storage is provider-agnostic: Cloudflare R2 for global regions, Alibaba OSS for China. Each region only has env vars for its provider.

## File Structure

```
packages/cloud/src/
├── api/hono/client/asg/
│   └── gallery.api.ts               # All endpoints (glasses + mobile)
├── services/client/gallery/
│   ├── gallery.provider.ts          # GalleryProvider interface
│   ├── cloudflare.gallery.provider.ts   # Cloudflare R2 implementation
│   ├── alibaba.gallery.provider.ts      # Alibaba OSS implementation
│   └── gallery.service.ts           # Business logic + provider factory
├── models/
│   └── gallery-item.model.ts
└── jobs/
    └── gallery-cleanup.job.ts       # TODO
```

## API Summary

### Glasses → Cloud (`/api/client/asg/gallery/*`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/upload` | Upload image directly (multipart/form-data) |
| POST | `/video-upload-url` | Get presigned URL for video upload |
| POST | `/video-upload-complete` | Confirm video upload finished |

### Mobile → Cloud (`/api/client/asg/gallery/*`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/pending` | Stats + items with download URLs |
| POST | `/mark-synced` | Mark items synced, delete from storage |
| DELETE | `/:id` | Delete item without downloading |

## Environment Variables

### Cloudflare R2 (Global regions)

```bash
CLOUDFLARE_ACCOUNT_ID=xxx
CLOUDFLARE_R2_ACCESS_KEY_ID=xxx
CLOUDFLARE_R2_SECRET_ACCESS_KEY=xxx
CLOUDFLARE_R2_GALLERY_BUCKET=mentra-gallery
```

### Alibaba OSS (China - to be configured by China team)

```bash
ALIBABA_ACCESS_KEY_ID=xxx
ALIBABA_ACCESS_KEY_SECRET=xxx
ALIBABA_OSS_REGION=oss-cn-shenzhen
ALIBABA_OSS_ENDPOINT=xxx  # Optional, for custom domain
ALIBABA_GALLERY_BUCKET=mentra-gallery
```

## Key Decisions

1. **Single auth system**: Glasses use same JWT as mobile
2. **Single API file**: Both glasses and mobile use `/api/client/asg/gallery/*`
3. **Multi-provider storage**: `GalleryProvider` interface with `CloudflareGalleryProvider` and `AlibabaGalleryProvider`
4. **All in one place**: Interface, providers, and service all live in `services/client/gallery/`
5. **Provider tracking**: Each `GalleryItem` stores `storageProvider` type
6. **Presigned URLs**: Videos stream direct to storage, downloads use presigned URLs (1hr expiry)
7. **Delete on sync**: Cloud storage is temporary relay, not permanent backup
8. **No public bucket**: All access via presigned URLs for security

## Status

### Implementation
- [x] Create `gallery.provider.ts` (interface)
- [x] Create `cloudflare.gallery.provider.ts`
- [x] Create `alibaba.gallery.provider.ts`
- [x] Create `gallery.service.ts`
- [x] Create `gallery-item.model.ts`
- [x] Create `gallery.api.ts` (Hono)
- [x] Register route in `hono-app.ts`
- [x] Add AWS SDK dependencies (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`)

### Environment Setup
- [x] Create R2 bucket (`mentra-gallery`)
- [x] Create R2 API credentials
- [x] Add env vars to `.env` and `.env.example`
- [x] Add env vars to Porter (all clusters)
- [x] Add env vars to Doppler (dev, staging, prod)

### Remaining
- [ ] Create cleanup job (schedule `cleanupStaleUploads()` hourly)
- [ ] Test end-to-end flow with glasses/mobile
- [ ] Alibaba OSS credentials (China team)