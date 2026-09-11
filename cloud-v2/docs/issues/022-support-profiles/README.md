# Cloud V2 support profiles

**Status:** Implemented

Support profiles give authorized Mentra support staff a current, low-volume view of the app, phone, and glasses software a user is running. They complement reports: a profile answers “what is this user running now?”, while `/api/admin/reports/:reportId` remains the deep diagnostic surface for user-submitted context, logs, and screenshots.

## Data flow

1. The engine sends an authenticated `PUT /api/client/support-profile` after startup, on a meaningful glasses-state or version change (2-second debounce), and every six hours as a freshness heartbeat.
2. Core derives identity only from the verified bearer token. A raw glasses serial may cross TLS solely to derive an HMAC device ID; the raw value is then discarded.
3. MongoDB stores one canonical profile per `mentraUserId`, with the 12 most recently seen devices. Writes are last-write-wins — this is an operational read model, not an event log, and support only needs the latest picture. Observations older than the stored snapshot and identical requests inside 60 seconds do not write.
4. Meaningful transitions are mirrored to PostHog inline, best-effort: one attempt, then the event is logged and dropped. Analytics downtime can lose a transition event but can never fail or delay the canonical profile update.
5. Authorized support staff use `GET /api/admin/support-profiles/lookup?email=...`. The route exact-matches a verified first-party account, returns explicit freshness/source fields and recent report links, and writes an admin audit record without copying the email into the audit metadata.

## Allowed fields

- Mentra App version/build, engine version, and Bluetooth SDK version
- Phone platform, model/name, and OS version
- Normalized glasses connection state and optional normalized failure code/stage
- Glasses model, Android/firmware/MTK/BES versions, glasses app version/build
- First/last seen, last connected, client observation, and server receipt timestamps

The ingestion schema is strict and limited to 16 KiB. It does not accept or persist access/refresh tokens, passwords, Wi-Fi data, Bluetooth/MAC addresses, location, content, logs, transcripts, photos, or arbitrary metadata.

`SUPPORT_DEVICE_ID_HMAC_KEY` should be a dedicated high-entropy secret. With it, serials produce stable, non-reversible device IDs. If it is absent, Core deliberately falls back to a model-derived ID: support can still see history, but two glasses of the same model cannot be distinguished. Device IDs are never sent to PostHog.

## PostHog contract

Set `POSTHOG_API_KEY` and optionally `POSTHOG_HOST` (default `https://us.i.posthog.com`) on Core. Events use the stable `mentraUserId` as `distinct_id`; Core adds an email person property only after resolving an email-verified first-party GoTrue identity. The Mentra App also calls `identify(mentraUserId)` for its own analytics, while the embedded Bluetooth SDK's anonymous analytics are disabled only in the Mentra App host configuration. Standalone SDK integrations keep their default anonymous analytics.

Events:

- `support_profile_created`
- `support_glasses_connected`
- `support_glasses_disconnected`
- `support_connection_changed`
- `support_software_changed`
- `support_failure_observed`

Person/event properties use the `support_` prefix and contain only the allowed host/device fields. There is no per-heartbeat PostHog event when nothing meaningful changed.

## Retention and deletion

The canonical profile is retained with the Cloud V2 account because it is an operational support read model. Account deletion tombstones the user and removes the profile before deleting the identity-provider account. Delivered PostHog data follows the analytics project's configured retention/deletion policy. Admin reads remain in the existing admin audit collection.

## Freshness semantics

- `fresh`: received in the last 15 minutes
- `stale`: older than 15 minutes and no more than 24 hours old
- `outdated`: older than 24 hours

The admin response includes both `observedAt` (phone clock), `receivedAt`/`lastSeenAt` (Core clock), and `source: cloud_v2_mobile_support_profile`; support tooling should display these labels rather than implying the device is live.
