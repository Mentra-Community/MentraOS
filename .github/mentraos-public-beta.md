# MentraOS Staging Public Beta

The coordinated staging release publishes MentraOS to Google Play `beta` (open
testing) and the external TestFlight group `Mentra Staging Public`. Dev retains
Google Play `internal` and the internal TestFlight group `Mentra Dev`. Production
release and compatibility workflows are unchanged.

New coordinated beta plans freeze the external TestFlight policy in
`native.testflight`. Old plans without that field retain the historical
`Mentra Staging` coordinate, so existing immutable manifests remain valid.

The existing App Store Connect helper creates/enables the named public group and
its public invitation link. It checks review metadata and pending/rejected
reviews before assigning the exact processed build and submitting it to Apple.
It never automatically overrides a rejection or clears review notes.

If setup or an earlier review blocks distribution, the uploaded build remains
recorded, with a separate `testflight.status` of `skipped` and a reason. Otherwise
the distribution is `submitted` until approval, or `available` when approval is
confirmed. These details and the public invitation URL are included in the
release manifest and Slack notification; upload success alone is not public
availability. The manifest is an immutable snapshot, not a live review monitor.

Before inviting testers, verify that App Store Connect has complete beta review
contact/app-access information and that the staging build is approved. On Google
Play, verify the open-test countries, review status, and any managed-publishing
hold. Existing unrelated publishing changes must not be published as part of this
setup. Neither public-beta route publishes to production.
