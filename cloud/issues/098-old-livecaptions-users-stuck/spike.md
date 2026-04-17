# 098 — Old LiveCaptions Users Stuck on Dead Webhook

## Summary

13 users still have `com.augmentos.livecaptions` (the old AugmentOS-era captions app) installed.
Every time they connect, the cloud tries to resurrect it by hitting its webhook.
The webhook URL points to the `live-captions-global` Porter deployment, which is Pending and has no running pod.
The webhook fails with `ECONNREFUSED` after 2 retries, every single time.

One user (`xandyedgex@gmail.com`) has hit this **369 times in the past 7 days**.
These users have no idea why captions "doesn't work."

The current captions app is `com.mentra.captions`.
These users need to be migrated.

## Evidence

### The failure chain (from BetterStack logs)

```
🚀🚀 Starting App com.augmentos.livecaptions for user xandyedgex@gmail.com
⚡️ Starting app com.augmentos.livecaptions - creating pending connection
Triggering webhook for com.augmentos.livecaptions: http://live-captions-global-live-captions.default.svc.cluster.local:80/webhook
Webhook failed after 2 attempts: ECONNREFUSED
Failed to start previously running app com.augmentos.livecaptions
🛑 Stopping app: com.augmentos.livecaptions
```

This repeats every time the user reconnects to the cloud.

### What happens step by step

1. User connects to cloud (phone opens, glasses pair, etc.)
2. Cloud checks `user.runningApps` in the database
3. `com.augmentos.livecaptions` is in the list (user installed it months ago)
4. Cloud looks up the app in the `apps` collection, finds its `publicUrl`
5. Cloud sends POST to `http://live-captions-global-live-captions.default.svc.cluster.local:80/webhook`
6. `live-captions-global` pod is Pending (requests 3 cores / 4 GB, can't schedule)
7. Kubernetes DNS resolves the service name but the connection is refused (no pod behind the service)
8. Cloud retries once, fails again
9. Cloud logs the failure, stops the app
10. User sees nothing — captions just doesn't start

### Affected users (past 7 days)

| User                                | Failed attempts |
| ----------------------------------- | --------------- |
| xandyedgex@gmail.com                | 369             |
| rokudou.13@gmail.com                | 168             |
| info@addressesop.com                | 166             |
| aayu@outdooragi.com                 | 76              |
| webmail.net@gmail.com               | 70              |
| smith.dakota303@gmail.com           | 69              |
| dcbpsaj@gmail.com                   | 38              |
| night4fever@hotmail.com             | 31              |
| hanneslowagie@gmail.com             | 15              |
| miro.rwth@gmail.com                 | 3               |
| fabio.huwyler@gmail.com             | 3               |
| ianlohmullercheberle@gmail.com      | 3               |
| dxb2rdpzgy@privaterelay.appleid.com | 3               |

### The dead deployment

Porter name: `live-captions-global`
Cluster: US Central (4689)
Status: **Pending** (can't schedule — requests 3 cores / 4 GB)
Repo: AugmentOS-Community/LiveCaptionsOnSmartGlasses (old org)
Package name: `com.augmentos.livecaptions`
Webhook URL: `http://live-captions-global-live-captions.default.svc.cluster.local:80/webhook`

The current production captions is `com.mentra.captions`, deployed as `captions` on Porter, running fine.

## The Problem

The app `com.augmentos.livecaptions` still exists in the `apps` MongoDB collection.
These users still have it in their `runningApps` or installed apps list.
The cloud faithfully tries to start it every time they connect.
The webhook URL points to a dead deployment.

There's no mechanism for:

- Detecting that a webhook URL is permanently dead (vs temporarily down)
- Auto-migrating users from a deprecated app to its replacement
- Notifying the user that an app they have installed no longer works

## Fix Options

### Option A: Database migration (cleanest)

Write a migration script that:

1. Finds all users with `com.augmentos.livecaptions` in their installed/running apps
2. Replaces it with `com.mentra.captions`
3. Removes `com.augmentos.livecaptions` from their app lists

This fixes all 13 users immediately.

### Option B: App redirect in the cloud

Add an app alias/redirect in the cloud's app resolution:

- When the cloud tries to start `com.augmentos.livecaptions`, redirect to `com.mentra.captions` instead
- Log the redirect so we can track how many users are still on the old name

This is more resilient — works for any user who has the old app cached on their phone.

### Option C: Mark the old app as deprecated in the DB

Set `com.augmentos.livecaptions` to a deprecated status.
When the cloud encounters a deprecated app in `runningApps`, it:

- Skips the webhook
- Removes it from the user's running apps
- Optionally installs the replacement (`com.mentra.captions`) automatically

### Option D: Delete the old app from the DB

Remove `com.augmentos.livecaptions` from the `apps` collection entirely.
The cloud won't find it during app lookup, so it won't try to start it.
Users still have it in their installed list but it will silently not start.

This is the simplest but least user-friendly — the user loses captions with no explanation.

### Option E: Fix the dead deployment

Get `live-captions-global` running again by reducing its resource request.
This fixes the symptom but keeps users on the old deprecated app.
Not recommended as a long-term fix.

## Recommendation

**Option A (migration) + Option C (deprecation flag).**

Migration script fixes the 13 current users.
Deprecation flag prevents future users from hitting the same wall if they somehow still have the old app cached.

The migration needs:

- Access to MongoDB (via `mongosh` or a script in `cloud/packages/cloud/scripts/migrations/`)
- The exact field paths for installed apps and running apps on the User model
- Testing on a single user first before running for all 13

## Also Found: Other Captions Failures

While investigating, found other captions failure patterns in the last 24 hours:

**`com.mentra.captions` webhook returns 503**
Users: `alfoalongi87@gmail.com` (France), `mario.mercado@batstoi.com` (US Central)
The current captions server is intermittently returning 503 during resurrection.
This is a separate issue — the server exists but is temporarily unavailable.

**`com.mentra.captions` connection failed: "App not started for this session"**
User: `dgm288k4z7@privaterelay.appleid.com` (France)
Session ID mismatch during reconnection. Related to the v3 session lifecycle work.

**`fr.fdesousa.captions` webhook returns 404**
User: `philippe+macmini@mentraglass.com` (East Asia, US Central)
A third-party captions app whose server is gone. Separate issue.

## Related Issues

- [097 — Porter Mini App Cleanup](../097-porter-mini-app-cleanup/) — `live-captions-global` is flagged as 🔴 delete in the inventory
- [095 — Cloudflare Session Affinity](../095-cloudflare-session-affinity/) — Philippe's region switching also caused captions failures
- [096 — Transport Observability](../096-transport-observability-and-error-model/) — webhook failures are part of the fail-slow audit

## Action Items

- [ ] Write migration script to move users from `com.augmentos.livecaptions` to `com.mentra.captions`
- [ ] Test on one user first (`miro.rwth@gmail.com` — only 3 attempts, low risk)
- [ ] Run for all 13 users
- [ ] Add deprecation flag to old app in DB so future attempts are caught
- [ ] Delete the `live-captions-global` Porter deployment (it's Pending and useless)
- [ ] Investigate the intermittent 503s on the current `com.mentra.captions` server
