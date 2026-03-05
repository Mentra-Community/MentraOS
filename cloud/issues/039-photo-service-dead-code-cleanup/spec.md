# Spec: Photo Service Dead Code Cleanup

## Overview

**What this doc covers:** Removing deprecated photo service files and their remaining consumers that were superseded by `PhotoManager` in the user session.

**Why this doc exists:** During issue 038 (photo error REST endpoint), we found two deprecated service files (`photo-request.service.ts`, `photo-taken.service.ts`) that are marked `NOTE(isaiah): This file is deprecated and not used, any logic should be in services/session/PhotoManager` — but they still have active imports from hardware routes, photos routes, and glasses-auth middleware. This creates confusion for devs and AI agents who encounter them and assume they're live code paths.

**Who should read this:** Cloud engineers doing the cleanup.

## The Problem in 30 Seconds

PhotoManager replaced the old global photo services, but the old files were never fully removed. They still have importers, creating two parallel code paths for photo handling — one live (PhotoManager), one zombie (the deprecated services). This will confuse anyone working on photo features.

## What's Dead

### 1. `services/core/photo-request.service.ts`

Global singleton `PhotoRequestService` with its own `pendingPhotoRequests` map. Superseded by `PhotoManager` which lives on the `UserSession` and manages per-session photo requests.

**Still imported by:**

| File                                    | Usage                                                    |
| --------------------------------------- | -------------------------------------------------------- |
| `api/hono/routes/hardware.routes.ts`    | `createSystemPhotoRequest()`, `getPendingPhotoRequest()` |
| `routes/hardware.routes.ts`             | Same (Express version)                                   |
| `middleware/glasses-auth.middleware.ts` | `hasPendingPhotoRequest()` for upload validation         |

### 2. `services/core/photo-taken.service.ts`

Legacy photo upload handler. Superseded by PhotoManager's `handlePhotoResponse()`.

**Still imported by:**

| File                               | Usage                  |
| ---------------------------------- | ---------------------- |
| `api/hono/routes/photos.routes.ts` | Photo upload handling  |
| `routes/photos.routes.ts`          | Same (Express version) |

## Spec

### Step 1: Migrate hardware routes to use PhotoManager

The hardware button press handler creates "system photo requests" via the deprecated service. This should go through `userSession.photoManager.requestPhoto()` instead, which already handles the full flow (send to glasses, track pending, forward response to app).

### Step 2: Migrate glasses-auth middleware upload validation

`glasses-auth.middleware.ts` checks `photoRequestService.hasPendingPhotoRequest(requestId)` to validate upload requests. This should check `userSession.photoManager` instead — the pending requests live there now.

### Step 3: Migrate photos routes to use PhotoManager

The photo upload routes use `photoTakenService` to process uploads. This should delegate to PhotoManager's existing methods.

### Step 4: Delete the deprecated files

- `services/core/photo-request.service.ts`
- `services/core/photo-taken.service.ts`

### Step 5: Clean up Express duplicates (if still present)

The Express versions of hardware.routes.ts and photos.routes.ts may also need updating or removal depending on whether the Express server is still serving these routes.

## Decision Log

| Decision                                                    | Alternatives considered              | Why we chose this                                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrate consumers to PhotoManager rather than just deleting | Delete files and let consumers break | The hardware button flow and upload validation are real features — they just need to use the right service                                                |
| Separate issue from 038                                     | Do it all in 038                     | 038 is scoped to the REST endpoint for photo errors. This cleanup touches hardware routes, upload validation, and Express compat — different blast radius |
