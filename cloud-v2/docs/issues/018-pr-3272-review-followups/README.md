# 018 - PR #3272 review follow-ups

**Status:** Open. Tracks the review-bot findings on PR #3272 that were
acknowledged but intentionally deferred (replied to on the PR rather than fixed
in the branch). The findings that were fixed are listed at the bottom for
reference.

PR: https://github.com/Mentra-Community/MentraOS/pull/3272

## Deferred items

### 1. Enterprise org disable / session revocation mechanism

- **Severity:** Medium. **Source:** discussion on the enterprise-refresh fix.
- **Problem:** Refresh now validates enterprise tenants against `EnterpriseOrg.status === "active"`, but **nothing can set an enterprise org to `disabled`** (no status setter, no admin/portal endpoint). The only existing enterprise off-switch is `setTrustedIssuerEnabled` (`enterprise.service.ts:103`), which blocks new token exchanges but does not affect refresh. So enterprise sessions have no working refresh-time kill-switch.
- **Fix:** Add an admin/portal action to disable an enterprise org (set `status: "disabled"`) plus an enterprise sibling of `revokeOemSessions` (delete the org's refresh tokens). Then the refresh-time `assertTenantStillAuthorized` check becomes a live revocation lever.
- **PR thread:** https://github.com/Mentra-Community/MentraOS/pull/3272#discussion_r3500194324

### 2. Enforce accepted/published status in preinstall `resolveEntry`

- **Severity:** P2 (defense in depth). **Source:** Codex Review.
- **Location:** `cloud-v2/packages/core/src/services/miniapps/preinstalled-registry.service.ts` (`resolveEntry`, ~line 229).
- **Problem:** `resolveEntry` accepts any release id that has a bundle, without checking the release status. An admin/API caller could stage a draft/rejected/suspended release into a registry revision, bypassing the accepted/published gate the eligible-releases listing applies. Admin-gated, so low likelihood. Note this is partly mitigated already: `getBundleAsset` now refuses to serve non-accepted/published bundles (fixed in `e6a66a5`), so the bundle would not actually download, but the registry invariant is still not enforced on write.
- **Fix:** Reject `status` not in `{accepted, published}` in `resolveEntry`.
- **PR thread:** https://github.com/Mentra-Community/MentraOS/pull/3272#discussion_r3500194479

### 3. Honor mobile-version bounds before installing (mobile app)

- **Severity:** P2. **Source:** Codex Review. **Owner:** mobile team (outside the cloud-v2 edit boundary).
- **Location:** `mobile/src/services/miniapps/preinstalledMiniappSync.ts` (`shouldInstall`, ~line 8-14).
- **Problem:** Registry entries carry `minMobileVersion`/`maxMobileVersion` (real schema fields on `preinstalled-registry-revision.model`), but the installer never checks them, so incompatible app builds install anyway.
- **Fix:** Skip entries outside the current app version before applying the install policy.
- **PR thread:** https://github.com/Mentra-Community/MentraOS/pull/3272#discussion_r3500194628

### 4. Signed / expiring bundle download URLs (hardening)

- **Severity:** follow-on to the High-sev bundle-download finding (the core issue was fixed).
- **Location:** `cloud-v2/packages/core/src/api/client/miniapps.api.ts` (`/bundles/:assetId/download`).
- **Problem:** The download endpoint is unauthenticated by design (the on-device installer fetches by plain download and verifies sha256). The exposure of unpublished bundles was closed by scoping `getBundleAsset` to accepted/published (`e6a66a5`), but it remains a capability-URL model: anyone with a published asset id can download it.
- **Fix (optional hardening):** Move to signed/expiring URLs, or add auth and update the mobile downloader to send the token.
- **PR thread:** https://github.com/Mentra-Community/MentraOS/pull/3272#discussion_r3500393106

### 5. Honor WorkOS org selection before the owned org

- **Severity:** P2. **Source:** Codex Review. **Owner:** console org-selection flow.
- **Location:** `cloud-v2/packages/core/src/api/console/cli-auth.api.ts` (`resolveDeveloperOrgForSession`, ~line 1041).
- **Problem:** The resolver returns the user's owned org before honoring the WorkOS `organizationId` selection, so an owner who switches to a team org still operates on their personal org (`/me`, apps, releases, tokens).
- **Fix:** Check the selected `organizationId` first, then fall back to owned org, then memberships.
- **PR thread:** https://github.com/Mentra-Community/MentraOS/pull/3272#discussion_r3500393418

### 6. Verify the uploaded zip manifest matches the release

- **Severity:** P2 (integrity / review bypass). **Source:** Codex Review.
- **Location:** `cloud-v2/packages/core/src/api/console/cli-auth.api.ts` (`assertSignedReleaseMatchesUpload` / `postRelease`, ~line 587-626).
- **Problem:** Publish verifies the signature against the submitted manifest and the bundle byte-hash, but never opens the zip to check its internal `miniapp.json`. A signed bundle could declare a different `packageName`/`version` internally than was reviewed; the on-device installer reads the zip manifest, so an approved/preinstalled release could activate or overwrite a different miniapp.
- **Fix:** Unzip server-side and require the bundle's `miniapp.json` `packageName`/`version` to match the release metadata before storing. Needs a small unzip dependency in core (e.g. `fflate`); none exists today.
- **PR thread:** https://github.com/Mentra-Community/MentraOS/pull/3272#discussion_r3500393754

### 7. Publish `@mentra/auth` to npm

- **Severity:** Low (developer experience). **Source:** issue 017 / handoff.
- **Problem:** External developers cannot install `@mentra/auth` yet. Today only the in-repo Merge backend picks it up from workspace source.
- **Fix:** Publish `@mentra/auth` to npm (and host the JWKS, already done across all four environments).

## Fixed in PR #3272 (no follow-up needed)

- Enterprise sessions dying on refresh (P1) - `89e885a6`.
- Reserved/OEM tenant-id collision at org create/rename (P1) - `e6a66a5`.
- Unauthenticated download of unpublished bundles (High) - `e6a66a5` (scoped `getBundleAsset` to accepted/published).
- Legacy refresh tokens missing `tenantId` backfill (High) - `d743548`.
