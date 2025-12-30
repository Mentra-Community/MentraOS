# App Store Using Mobile Client Endpoint

The app store website reuses the mobile client's `/api/apps/installed` endpoint, which includes destructive auto-cleanup logic. When users browse the app store while connected to a non-production cloud server, the store's API calls hit production and can delete apps from the shared database.

## Documents

- **001-problem-analysis.md** - Evidence, data flow, proposed fix

## Quick Context

**Current**: App store website calls `GET /api/apps/installed` (mobile client endpoint) which auto-deletes stale apps.

**Problem**: User connected to `cloud-debug`, opens app store (prod), prod endpoint deletes apps from shared DB.

**Fix**: Create read-only `GET /api/store/installed` endpoint for app store, no cleanup logic.

## Evidence

```
User isaiahballah@gmail.com connected to cloud-debug
App store webview loads from prod
→ GET /api/apps/installed (prod)
→ "Auto-deleted 2 app(s) for user: isaiahballah@gmail.com"
```

## Key Insight

All environments (local, dev, staging, prod) share the same MongoDB. Destructive operations from any environment affect all others.

## Status

- [x] Problem identified
- [x] Root cause confirmed (shared endpoint with cleanup logic)
- [ ] Create read-only `/api/store/installed` endpoint
- [ ] Update app store website to use new endpoint
- [ ] Audit other endpoints for similar issues

## Files Involved

| File                                       | Issue                                       |
| ------------------------------------------ | ------------------------------------------- |
| `packages/cloud/src/routes/apps.routes.ts` | `/api/apps/installed` has auto-delete logic |
| `cloud/websites/store/`                    | App store website calling mobile endpoint   |

## Open Questions

1. Are there other endpoints with destructive side effects being called from the store?
2. Should we add environment checks before destructive operations?
3. Long-term: should environments have separate databases?
