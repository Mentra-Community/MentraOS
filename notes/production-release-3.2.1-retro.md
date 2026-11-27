---
status: active
owner: aisraelov
---

# Production release 3.2.1: snags and follow-ups

Retro of promoting `3.2.1-beta.578` to production with `scripts/production-release.mjs` (runbook:
`.github/production-release/README.md`), 2026-10-03 to 2026-10-05. It records every snag hit, its root cause, how we
got past it, and what is still open.

## Outcome

| Item | Result |
| --- | --- |
| Promoted beta | `3.2.1-beta.578` (`be56e1456c`), the same source tree as the heavily tested beta.570 |
| Cloud V2 | 3.2.1 deployed to production 2026-10-03 ([run 37160962306](https://github.com/Mentra-Community/MentraOS/actions/runs/37160962306)) |
| Mentra App | 3.2.1 (iOS and Android build `302010079`) approved by both stores; public release recorded (`public-release-approved`) |
| SDK | npm `latest` = 3.2.1 for all nine `@mentra` packages; Maven Central `com.mentraglass:{bluetooth-sdk,lc3Lib}:3.2.1`; SwiftPM tag `3.2.1` |
| Not yet done | Store release clicks → `next` → `advance --complete`; publish the `mentra-v3.2.1` draft; `example`; back-merge `main` (#4481, #4484) into staging and `dev` |

## Snags, in the order we hit them

### 1. `main` contained an accidental merge of `dev` and its revert

- **What happened:** `promote` refused beta.570: the beta did not contain `main`. On 2026-09-29 a local `git merge dev` was
  pushed straight to `main` (`0a046f9a3c`) and reverted four minutes later (`7bda05153b`).
- **Why it was dangerous:** the script's advice, "back-merge main into staging", would have applied the revert. A dry
  run gave 83 conflicts and about 171k deleted lines. Keeping staging's tree (`-s ours`) looked clean but turned the next
  staging→`dev` back-merge into 244 conflicts.
- **Fix:** force-reset `main` to `0f2351ee0f` (the 3.1.1 promotion merge; byte-identical tree). Branch protection blocks
  force pushes even for admins. The push needed a temporary `bypassForcePushActorIds` entry, removed afterwards; the
  protection settings were verified identical to a snapshot.
- **Follow-up:** stop direct pushes to `main`. Restrict pushes to the release automation, or turn on "Do not allow
  bypassing the above settings".

### 2. The `main` → staging back-merge was skipped after 3.1.1

- **What happened:** even without snag 1, beta.570 was unpromotable. Every promotion merges into `main` with a merge
  commit, and nobody merged that commit back into staging after 3.1.1.
- **Fix:** #4416 (zero file changes), then a new beta, 578, built from a tree identical to 570.
- **Follow-up:** make the back-merge part of the release. `advance --complete` (or `promote`) should open the `main` →
  staging PR itself.

### 3. The 3.1.1 promotion was abandoned at `stores-submitted`

- **What happened:** 3.1.1 went live by hand, outside the CLI, with an unresolved deferral. Its records never reached
  `completed`, and `mentra-v3.1.1` stayed a draft.
- **Fix:** aborted attempt 2. Do **not** publish the `mentra-v3.1.x` drafts: `start` reads the newest *published*
  `mentra-vX.Y.Z`, and those drafts have no canonical records.
- **Follow-up:** if a release goes manual, abort the attempt the same day.

### 4. A beta build was held on the Play production track

- **What happened:** prepare refused the candidate: `302010079 is not above the Google Play production version code
  310000362`. `310000362` was beta.570's Android build, which is built against **staging Cloud**. It had been submitted
  to production by hand and was held by managed publishing.
- **Why it matters:** the Play inventory treats held (`completed`/`inProgress`, unpublished) releases as current.
  Clicking "Publish changes" would have shipped a staging-Cloud build to every Android user.
- **Fix:** Publishing overview → remove the change → Discard release.
- **Follow-up:** never submit `beta` builds to the production track. The prepare error should say "held release" when
  the code belongs to a beta.

### 5. A failed prepare left an empty attempt container that blocked the retry

- **What happened:** the failed prepare left a draft `mentra-production-promotion-v3.2.1-attempt-1` stamped with a
  digest of the old Play inventory. The retry failed with "Empty promotion attempt 1 belongs to another frozen
  selection". `abort` needs a state record, so the CLI had no way out.
- **Fix:** deleted the empty draft (0 assets) and re-ran `start`.
- **Follow-up:** `start` should replace an empty container whose selection changed, or `abort` should accept one.

### 6. The Cloud config contract lagged behind the code

- **What happened:** the Cloud preflight failed on 24 keys read by 3.2.x source that
  `.github/production-release/cloud-config-contract.json` did not classify: ACS/Teams/Entra meetings, OIDC, deployment
  manifest, `TEST_RUN_*`. None of them is set in the Doppler staging or prod configs.
- **Fix:** #4423 (on `main`, which the preflight reads) marked them optional. We validated it locally against the real
  Porter env groups: staging and prod both pass. Codex and Bugbot then found another unclassified key on staging,
  `AUDIO_FRAME_TIMELINE_ENABLED` (#4472), plus `TEST_HOST_TOKENS` and `NIGHTLY_ROUTINE_LANES` on `dev`. Fixed in #4480.
- **Follow-up:** run the contract coverage check (`validate-production-cloud-config.mjs --root .`) in PR CI for
  `cloud-v2/**`, so a new `process.env` key fails at review time, not at release time.

### 7. ACS/Teams keys looked missing but are not used by hosted Cloud

- **What happened:** we briefly wondered whether production should copy ACS/Teams keys from staging.
- **What we found:** the Cloud V2 runtime `meetings` service needs a private-deployment manifest. It refuses to start
  without one (`runtime/src/index.ts`), and only the Azure enterprise template enables it. `/api/meetings/acs/token` is
  404 on hosted dev, staging and prod. Mentra Call mints ACS tokens through its own backend
  (`mentra-call-miniapp-dev.mentraglass.com`). Its `@mentra/auth` checks prod, staging, dev and debug JWKS, so production
  users are accepted.
- **No action needed.** Do not set `RUNTIME_SERVICES=meetings` on hosted Cloud: runtime would not start.

### 8. The runbook's approval gates are not configured

- **What happened:** `production-cloud`, `production-mobile-candidates`, `production-packages` and
  `production-packages-release` have no required reviewers, and `production-store-release` did not exist. The production
  Cloud deploy ran as soon as it was dispatched.
- **Follow-up:** decide. Either configure the gates (required reviewer, prevent self-review) or change the runbook to
  match how we work.

### 9. `attest` and `defer` need `GH_TOKEN`

- **What happened:** the CLI failed with "GH_TOKEN is required to upload a release asset" even though `gh` was logged in.
- **Follow-up:** fall back to `gh auth token`.

### 10. The production candidate build waited behind a dev build

- **What happened:** the candidate build queued for about 25 minutes. Every mobile store upload shares the
  `coordinated-mobile-publication` concurrency group (`queue: max`), and a `dev` coordinated build held it.
- **Follow-up:** give production its own lock or priority.

### 11. The debug "Prod" Cloud preset leads to "Email verified!"

- **What happened:** testing the App Store 3.1.1 app after pointing it at staging and back, Sign in with Apple landed on
  the old "Email verified!" page.
- **Root cause (pre-existing):** the debug preset is `core.mentraglass.com`. Its OAuth callback is not on Supabase's
  redirect allowlist, so GoTrue falls back to the Site URL. Shipped builds use `core.us-west-2.mentraglass.com`, which is
  allowlisted. Reinstalling fixed it.
- **Follow-up:** add `https://core.mentraglass.com/api/account/oauth/callback**` to the Supabase allowlist, or point the
  preset (`CloudUrl.tsx`) at `core.us-west-2`.

### 12. The Android candidate cannot be installed for acceptance

- **What happened:** the runbook says candidates go to the Play internal track. The workflow actually uploads a draft
  on the production track, which nobody can install from Play.
- **Fix:** accepted on the iOS candidate plus the identical-source beta.570 testing, with that limitation written into
  the attestation (the precedent is 3.1.1).
- **Follow-up:** also upload the candidate to Internal App Sharing, or fix the runbook.

### 13. `status --refresh` can never work

- **What happened:** `production-release-status.yml` runs with `permissions: contents: read`, which cannot see the
  draft promotion container: "Expected exactly one promotion container …, found 0". The workflow has no successful run.
  Store approval was recorded from the release owner reading both consoles.
- **Follow-up:** give it `contents: write`. It still never mutates anything.

### 14. Transient empty asset download

- **What happened:** packages phase 1 died on `unexpected end of JSON input` while fetching a promotion record that
  downloads fine locally.
- **Fix:** reran it.
- **Follow-up:** retry asset downloads in `production-promotion-assets.mjs`.

### 15. Editing a draft release untags it (the main package-pipeline bug)

- **What happened:** phase 1 failed with "Immutable asset name must equal the source file basename". After #4481 worked
  around that, phase 2 failed with "Sonatype deployment record must be unique". The package records were split across
  **three** `Mentra 3.2.1` drafts, two of them `untagged-…`.
- **Root cause, confirmed with a throwaway draft:** GitHub resets a draft release's tag to `untagged-<hash>` when an
  update omits `tag_name`. `publishR2Artifact` PATCHed only the body to add the CDN download link, so the first public
  artifact (the SwiftPM export) untagged the stable `mentra-v3.2.1` draft. The chain from there:
  - Later writes saw an untagged draft and took the private GitHub-asset path, where the Sonatype record's file name did
    not match its asset name: the #4481 symptom.
  - The next run's `ensure-container` looks the release up by tag, found none, and created another draft.
  - `advance --complete` finds the same release by tag, so it would have broken too.
- **Fix:** #4484 sends `tag_name` with the body for drafts. #4481 (copy the record under its asset name) stays as a
  harmless guard. Recovery: deleted the two empty drafts and re-tagged the draft holding the records (`404176677`) as
  `mentra-v3.2.1`.
- **Leftover:** the first failed run left an orphan USER_MANAGED Sonatype deployment named `mentra-3.2.1-android-sdk`.
  Drop it at central.sonatype.com, keeping the one recorded in the release.
- **Lesson:** "Re-run failed jobs" reuses the original commit, so fixes on `main` need a fresh dispatch.

### 16. npm `latest` returns 403 on the public SDK packages, again

- **What happened:** phase 2 moved `latest` on six packages, then got `403 Forbidden - PUT
  …/@mentra%2fbluetooth-sdk/dist-tags/latest`. That left the family split between 3.2.1 and 3.1.1 until the remaining tags were moved by hand.
  **3.1.1 hit the identical 403** (run 34869816043, 2026-09-14); it was finished by hand and never fixed.
- **Root cause:** `@mentra/bluetooth-sdk` (and evidently `engine` and `miniapp`) publish through OIDC trusted publishers,
  which cover `npm publish` only. Their publishing access is "Require two-factor authentication and disallow bypass 2fa
  tokens", so the CI `NPM_TOKEN` (last changed 2026-07-17) cannot move dist-tags on them.
- **Fix:** the release owner ran `npm dist-tag add @mentra/{bluetooth-sdk,engine,miniapp}@3.2.1 latest` with 2FA, then
  phase 2 was re-run.
- **Follow-up:** pick one of these:
  - Switch those three packages to "2FA or a granular token with bypass 2FA" and make `NPM_TOKEN` such a token.
  - Have phase 2 check write access for **every** package before moving any `latest`, and print the manual commands
    instead of failing halfway.

### 17. Device-routine request checks fail on PRs targeting `main`

- **What happened:** "Request device routine" and "Request routine authoring" fail with "PR routine requests require an
  open same-repository PR targeting dev or staging" on every release-tooling PR into `main` (#4423, #4481, #4484). They
  gate nothing.
- **Follow-up:** skip those jobs when `base.ref == 'main'`.

### Accepted, no action

- **Store release notes:** the custom text differs from `changelogs/3.2.1.md`. The in-app glasses-update screen still
  shows the markdown file.
- **Mentra Call backend:** the bundled Mentra Call (2.1.40) uses the `mentra-call-miniapp-dev` backend in production too.

## Follow-up checklist

- [ ] Back-merge `main` (#4481, #4484) → staging → `dev`, as real merge commits
- [ ] Drop the orphan Sonatype deployment `mentra-3.2.1-android-sdk`
- [ ] Store release clicks → `next` → `advance --android-percent …` / `--complete` → publish the `mentra-v3.2.1` draft
- [ ] Run `production-release.mjs example` once the Play track "Mentra Bluetooth Example Production Candidates" exists
- [ ] npm publishing access / `NPM_TOKEN` (snag 16)
- [ ] Contract coverage check in PR CI (snag 6)
- [ ] `production-release-status.yml` permissions (snag 13)
- [ ] Back-merge automation after promotion (snag 2)
- [ ] Empty-container recovery in `start`/`abort` (snag 5)
- [ ] Decide on protected-environment reviewers (snag 8)
- [ ] `main` push restrictions (snag 1)
- [ ] CLI `GH_TOKEN` fallback (snag 9); asset download retry (snag 14); routine-request skip on `main` (snag 17)
- [ ] Supabase allowlist or `CloudUrl.tsx` preset (snag 11); Android candidate installability (snag 12)
