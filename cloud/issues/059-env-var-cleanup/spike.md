# Spike: Environment Variable Cleanup — Full Audit

## Overview

**What this doc covers:** A full audit of every environment variable referenced in the cloud server codebase vs what's configured in Doppler, identifying dead vars, redundant/duplicate vars, naming inconsistencies, and missing vars.
**Why this doc exists:** During the Doppler migration (058), we discovered at least 3 env vars that appear to be the same thing (`CLOUD_HOST_NAME`, `CLOUD_PUBLIC_HOST_NAME`, `CLOUD_PUBLIC_URL`), vars in Doppler that no code reads, code that reads vars not in Doppler, and naming conventions that differ across services (`R2_*` vs `CLOUDFLARE_R2_*`). Multiple engineers have added vars over time without a central registry, leading to confusion and drift.
**Who should read this:** Anyone working on cloud infrastructure, env var configuration, or Doppler.

**Depends on:**

- [058-multi-region-scaling](../058-multi-region-scaling/) — Doppler migration that surfaced these issues

---

## Background

Environment variables are the primary configuration mechanism for the cloud server. They're now managed via Doppler (as of 058), with ~60 vars in the prod base config and ~65 in dev/staging. The codebase references `process.env.*` in 50+ unique locations across 30+ files. Nobody has done a full audit of what's actually needed vs what's legacy cruft.

---

## Findings

### 1. Dead vars — in Doppler but not referenced in code

| Variable                 | In Doppler                 | Code References                                                                                                  | Verdict                                                                                                                                                                                 |
| ------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUD_HOST_NAME`        | All prod regions           | 0 (zero)                                                                                                         | **Dead.** No code reads this. Only `CLOUD_PUBLIC_HOST_NAME` and `CLOUD_LOCAL_HOST_NAME` are used.                                                                                       |
| `CLOUD_VERSION`          | All configs                | 0 — `CLOUD_VERSION` in `apps.routes.ts` is a hardcoded import from `CLIENT_VERSIONS.required`, not `process.env` | **Dead.** The env var is never read.                                                                                                                                                    |
| `UPTIME_SERVICE_RUNNING` | dev, staging               | 1 — but only triggers if explicitly `"true"`. Absence = service doesn't start (safe default).                    | **Remove from Doppler.** Not having it IS the correct behavior. If someone needs to enable UptimeService, they can add it explicitly. Keeping it set to `"false"` is cargo-cult config. |
| `JOE_MAMA_USER_JWT`      | All configs                | 1 — `auth.routes.ts` reads it for a test/debug auth bypass                                                       | **Review.** Likely a development convenience that shouldn't be in prod.                                                                                                                 |
| `SERPAPI_API_KEY`        | All configs                | 0                                                                                                                | **Dead.** No code reads this. Possibly used by an app, not the cloud server.                                                                                                            |
| `ANTHROPIC_API_KEY`      | All configs (value: `???`) | 0                                                                                                                | **Dead.** Placeholder that was never wired up.                                                                                                                                          |

### 2. The hostname mess — 3 vars that look like the same thing

| Variable                 | Value (US Central example)  | Code Usage                                                                                                                |
| ------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `CLOUD_HOST_NAME`        | `uscentralapi.mentra.glass` | **None.** Dead var.                                                                                                       |
| `CLOUD_PUBLIC_HOST_NAME` | `uscentralapi.mentra.glass` | `AppManager.ts` — builds `wss://` URL for app WebSocket connections. `app-message-handler.ts` — builds audio stream URLs. |
| `CLOUD_PUBLIC_URL`       | _(not in Doppler)_          | `photos.routes.ts` — builds photo upload response URLs. Currently undefined everywhere → photo URLs are broken.           |

**Analysis:** `CLOUD_HOST_NAME` and `CLOUD_PUBLIC_HOST_NAME` have identical values in every region. `CLOUD_HOST_NAME` is never read — it's a ghost. `CLOUD_PUBLIC_URL` is read but never set.

**Recommendation:** Delete `CLOUD_HOST_NAME` everywhere. The code uses `CLOUD_PUBLIC_HOST_NAME` (bare hostname like `uscentralapi.mentra.glass`) and `CLOUD_LOCAL_HOST_NAME` (K8s internal DNS). `CLOUD_PUBLIC_URL` in `photos.routes.ts` should either be replaced with `CLOUD_PUBLIC_HOST_NAME` (with protocol prefix) or the photos feature needs to be audited — it may be deprecated.

### 3. The R2 naming collision

Two separate R2 integrations exist with different naming conventions:

| Prefix                                                                                                               | Used By                                                | Code Files                               | Purpose |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------- | ------- |
| `R2_*` (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`)              | `r2-storage.service.ts`, `incident-storage.service.ts` | Photo/file storage (mentra-store bucket) |
| `CLOUDFLARE_R2_*` (`CLOUDFLARE_R2_ACCESS_KEY_ID`, `CLOUDFLARE_R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_R2_GALLERY_BUCKET`) | Not yet merged — gallery service PR                    | Gallery feature (mentra-gallery bucket)  |

**Analysis:** These are different R2 buckets with different credentials — NOT duplicates. The `R2_*` vars are for the existing mentra-store bucket. The `CLOUDFLARE_R2_*` vars are for the gallery feature that's in an unmerged PR. Both need to coexist.

**Problem:** The naming is confusing. One uses `R2_` prefix, the other uses `CLOUDFLARE_R2_`. They're both Cloudflare R2.

**Recommendation:** When the gallery PR merges, standardize on one naming convention. Either:

- Rename existing `R2_*` → `CLOUDFLARE_R2_STORE_*` and gallery to `CLOUDFLARE_R2_GALLERY_*`
- Or keep `R2_*` for the primary bucket and use `R2_GALLERY_*` for the gallery bucket
- Don't do this now — coordinate with the gallery PR author.

### 4. Vars referenced in code but missing from Doppler

| Variable                        | Where Used                                                       | Current Behavior                                                 | Recommendation                                                                                           |
| ------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `CLOUD_PUBLIC_URL`              | `photos.routes.ts`                                               | Undefined → photo URLs are broken (`undefined/uploads/filename`) | Audit if photos feature is used. If yes, derive from `CLOUD_PUBLIC_HOST_NAME`. If dead, remove the code. |
| `HOST_NAME`                     | `app-message-handler.ts` (fallback for `CLOUD_PUBLIC_HOST_NAME`) | Only hit if `CLOUD_PUBLIC_HOST_NAME` is also missing             | Not needed — `CLOUD_PUBLIC_HOST_NAME` is always set.                                                     |
| `R2_INCIDENTS_BUCKET`           | `incident-storage.service.ts`                                    | Falls back to `"mentra-incidents"`                               | Fine as-is — default is correct.                                                                         |
| `R2_PUBLIC_URL`                 | `r2-storage.service.ts`                                          | Falls back to `"https://mentra-store-cdn.mentraglass.com"`       | Fine as-is — default is correct. But not in Doppler, so can't be overridden per-region.                  |
| `STORE_PUBLIC_URL`              | `developer.routes.ts`                                            | Falls back to `"https://store.mentra.glass"`                     | Fine as-is.                                                                                              |
| `APP_STORE_URL`                 | `console.apps.service.ts`, `slack.service.ts`                    | Falls back to `"https://apps.mentra.glass"`                      | Fine as-is.                                                                                              |
| `DEV_CONSOLE_FRONTEND_URL`      | `resend.service.ts`, `slack.service.ts`                          | Falls back to `"https://console.mentra.glass"`                   | Fine as-is.                                                                                              |
| `EMAIL_SENDER`                  | `resend.service.ts`                                              | Falls back to `"Mentra <noreply@mentra.glass>"`                  | Fine as-is.                                                                                              |
| `SENTRY_DSN`                    | In Doppler, not yet wired in code                                | Error tracking not implemented yet (057 outstanding)             | Leave for now — will be used when `@sentry/bun` is added.                                                |
| `MEMORY_TELEMETRY_ENABLED`      | `MemoryTelemetryService.ts`                                      | Defaults to `false` if not set                                   | Should be set to `"true"` in prod Doppler configs. Still hasn't been flipped (flagged in 057).           |
| `SKIP_CLI_DB_VALIDATION`        | `cli.middleware.ts`                                              | Test-only flag                                                   | Don't add to Doppler.                                                                                    |
| `DEBUG_APPS`                    | `app.service.ts`                                                 | Adds debug apps to pre-installed list                            | Don't add to prod. Dev/debug only if needed.                                                             |
| `AUTO_SEND_DOWNTIME_EMAILS`     | `app-uptime.service.ts`                                          | Defaults to not sending                                          | Intentionally off. Don't add.                                                                            |
| `CLOUDFLARE_CUSTOMER_SUBDOMAIN` | `CloudflareStreamService.ts`                                     | Streaming service config                                         | Not in Doppler. May be needed if streaming is used.                                                      |

### 5. China/Alibaba vars — dormant but wired

The codebase has a China deployment path that uses:

- `DEPLOYMENT_REGION` (checked in 4 files — `"china"` triggers Alibaba services)
- `ALIBABA_ACCESS_KEY_ID`
- `ALIBABA_ACCESS_KEY_SECRET`
- `ALIBABA_ENDPOINT`
- `ALIBABA_WORKSPACE`
- `ALIBABA_DASHSCOPE_API_KEY`

None of these are in Doppler. They're only needed if `DEPLOYMENT_REGION=china`. This code is dormant but functional — don't remove it, but don't add the vars to Doppler unless a China deployment is planned.

### 6. Duplicate `AUGMENTOS_AUTH_JWT_SECRET` reads

This var is read independently in **12 separate files**, each doing `process.env.AUGMENTOS_AUTH_JWT_SECRET || ""`. This isn't an env var problem per se, but it's a code smell — should be read once in a config module and imported everywhere. Flagging for the spec.

### 7. `BETTERSTACK_ENDPOINT` has a hardcoded source ID

In `pino-logger.ts`:

```
const BETTERSTACK_ENDPOINT = process.env.BETTERSTACK_ENDPOINT || "https://s1311181.eu-nbg-2.betterstackdata.com";
```

The fallback URL contains the source ID `s1311181` (the old AugmentOS source). If `BETTERSTACK_ENDPOINT` isn't set, logs go to the old source regardless of `BETTERSTACK_SOURCE_TOKEN`. This should be cleaned up when the prod log source separation happens (057 outstanding item).

### 8. photos.routes.ts — is it used?

`photos.routes.ts` is registered in `hono-app.ts` (mounted as a route), so the endpoints exist. It uses `CLOUD_PUBLIC_URL` which is never set, meaning any photo upload response URL is `undefined/uploads/filename`. This suggests either:

- The feature is broken and nobody noticed → it's not used
- The client ignores the response URL and constructs it differently

**Needs investigation:** Check if the mobile client or any app calls the photo upload endpoints. If not, the route and its env var reference can be removed.

---

## Summary: What to Clean Up

### Phase 1: Safe deletes (no code changes needed)

| Action              | Variable                 | Configs                                   |
| ------------------- | ------------------------ | ----------------------------------------- |
| Delete from Doppler | `CLOUD_HOST_NAME`        | All prod regions                          |
| Delete from Doppler | `CLOUD_VERSION`          | All configs                               |
| Delete from Doppler | `UPTIME_SERVICE_RUNNING` | dev, staging                              |
| Delete from Doppler | `ANTHROPIC_API_KEY`      | All configs (placeholder `???`)           |
| Delete from Doppler | `SERPAPI_API_KEY`        | All configs (if confirmed unused by apps) |

### Phase 2: Code changes needed

| Action                                        | Details                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Fix `CLOUD_PUBLIC_URL` reference              | Either replace with `https://${CLOUD_PUBLIC_HOST_NAME}` or remove `photos.routes.ts` if dead |
| Consolidate `AUGMENTOS_AUTH_JWT_SECRET` reads | Create a shared config module, import everywhere                                             |
| Clean up `BETTERSTACK_ENDPOINT` fallback      | Remove hardcoded source ID from fallback URL                                                 |
| Review `JOE_MAMA_USER_JWT`                    | Should this exist in prod? It's a debug auth bypass.                                         |
| Add `MEMORY_TELEMETRY_ENABLED=true`           | To all prod Doppler configs (057 outstanding)                                                |
| Standardize R2 naming                         | Coordinate with gallery PR author when it merges                                             |

### Phase 3: Investigation needed

| Question                                                 | How to answer                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| Is `photos.routes.ts` used by any client?                | Search mobile codebase for photo upload API calls                  |
| Is `SERPAPI_API_KEY` used by any app (not cloud server)? | Search the apps packages                                           |
| Should `JOE_MAMA_USER_JWT` be in prod?                   | Ask the team — likely a dev convenience that leaked to prod config |

---

## Next Steps

1. **Phase 1 deletes** can be done immediately — zero risk, just removing dead Doppler vars
2. **Phase 2 code changes** should be a single PR with the cleanup
3. **Phase 3 investigations** can happen async — answers feed into the spec
4. Write `spec.md` after Phase 3 answers are in
