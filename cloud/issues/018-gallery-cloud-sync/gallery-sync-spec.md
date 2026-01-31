# Gallery Cloud Sync Spec

## Overview

Enable smart glasses to upload photos/videos to cloud storage, which mobile clients can later sync down. Decouples capture time from transfer time.

## Problem

Smart glasses capture photos and videos but have limited storage and intermittent connectivity:

1. **No direct transfer path**: Glasses can't reliably transfer large files to mobile over BLE/WiFi Direct
2. **Storage constraints**: Glasses have limited onboard storage, need to offload media
3. **Timing mismatch**: User captures media on glasses, wants it on phone later (not immediately)
4. **No current solution**: Media stuck on glasses until manual intervention

## Constraints

### Technical

- **Auth**: Glasses receive user's JWT from mobile during pairing - same auth as mobile client
- **Video size**: Videos can be large (100MB+), can't buffer through our servers
- **Multi-region storage**: China uses Alibaba OSS, rest of world uses Cloudflare R2
- **Storage costs**: Pay per GB stored + operations, must delete after sync
- **Regional isolation**: Each region only has env vars for its storage provider

### Product

- **Not a backup service**: Cloud storage is temporary relay, mobile is source of truth
- **User owns data**: Must be able to delete pending media from mobile
- **Privacy**: Media should be encrypted at rest, access-controlled per user

## Goals

1. **Glasses can upload images** via HTTP POST with existing JWT auth
2. **Glasses can upload videos** via presigned URL (streaming upload)
3. **Mobile can get pending media stats** with preview URLs
4. **Mobile can download media** via presigned URLs
5. **Mobile can mark media as synced** triggering cloud deletion
6. **Mobile can delete pending media** without downloading
7. **Storage provider abstraction** supporting R2 and Alibaba OSS

## Non-Goals

- **Permanent cloud storage**: Not building a photo backup service
- **Media organization**: No albums, tags, or sorting - that's mobile's job
- **Thumbnail generation**: Mobile handles resizing/previews client-side
- **Video transcoding**: Store original format only
- **Sharing**: No sharing links or multi-user access
- **Web gallery**: No web UI for viewing media
- **Cross-region access**: Users stay within their region

## Media Types

| Type | Max Size | Upload Method | Storage |
|------|----------|---------------|---------|
| Image (JPEG/PNG/HEIC) | 20MB | Direct POST | R2 / Alibaba OSS |
| Video (MP4/MOV) | 2GB | Presigned URL | R2 / Alibaba OSS |

## Storage Providers

| Region | Provider | SDK |
|--------|----------|-----|
| Global (US, EU, Asia) | Cloudflare R2 | @aws-sdk/client-s3 (S3-compatible) |
| China | Alibaba OSS | @aws-sdk/client-s3 (S3-compatible) |

Both providers are S3-compatible, so the implementation is similar. The `GalleryStorageService` factory picks the right provider based on available env vars.

## Metadata

Each uploaded media item has:

```typescript
interface GalleryItem {
  id: string;                    // UUID
  userId: string;                // User email
  type: 'image' | 'video';
  filename: string;              // Original filename from glasses
  mimeType: string;
  sizeBytes: number;
  storageProvider: 'cloudflare-r2' | 'alibaba-oss';  // Which provider stores this item
  storageKey: string;            // Provider-specific object key
  status: 'uploading' | 'pending' | 'synced' | 'deleted';
  capturedAt: Date;              // When glasses captured it
  uploadedAt: Date;              // When uploaded to cloud
  syncedAt?: Date;               // When mobile downloaded (then deleted)
  deviceId?: string;             // Which glasses uploaded
  metadata?: {
    width?: number;
    height?: number;
    duration?: number;           // Video duration in seconds
    gps?: { lat: number; lng: number };
  };
}
```

## API Summary

All endpoints mounted at `/api/client/asg/gallery/*` using existing `clientAuthWithEmail` middleware.

### Glasses → Cloud

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/upload` | Upload image directly (multipart/form-data) |
| POST | `/video-upload-url` | Get presigned URL for video upload |
| POST | `/video-upload-complete` | Confirm video upload finished |

### Mobile → Cloud

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/pending` | Get stats + list of pending items with download URLs |
| POST | `/mark-synced` | Mark items as synced (deletes from storage) |
| DELETE | `/:id` | Delete pending item without downloading |

## Open Questions

1. **Partial uploads**: What happens if video upload fails midway?
   - Leaning: Glasses retry from start, presigned URLs auto-expire

2. **Offline queue on glasses**: Should glasses queue uploads when no connection?
   - Leaning: Yes, ASG Android client handles this, not cloud's problem

3. **Duplicate detection**: What if same photo uploaded twice?
   - Leaning: Allow duplicates, mobile dedupes by content hash if needed

4. **Quota limits**: Should we limit pending media per user?
   - Leaning: Yes, 10GB or 100 items, whichever first - prevents abuse

5. **Presigned URL expiry**: How long should download URLs be valid?
   - Leaning: 1 hour, mobile refetches `/pending` for fresh URLs when needed