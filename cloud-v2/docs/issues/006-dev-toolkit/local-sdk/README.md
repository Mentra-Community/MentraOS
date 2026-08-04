# Cloud v2 ↔ Local JS SDK

**Status:** Spike (this doc + [`spike.md`](./spike.md)). Spec + design
come after team discussion.

## Problem

The client team is moving third-party developer code **off the cloud**
and **onto the phone** via the Local JS SDK (`@mentra/miniapp`). Mini
apps ship as static bundles, run in a JS context on the phone, and
call into a phone-resident runtime instead of a cloud `AppServer`.

That's a clean break from cloud v1's miniapp model. Cloud v1's
`@mentra/sdk` server protocol — app sessions, heartbeat, webhooks,
fan-out — is being **deleted**, not ported.

Per [OS-1446](https://linear.app/mentralabs/issue/OS-1446):
> Cloud 2 is the next major version of our cloud backend. The thing
> that makes it Cloud 2 is that it does not include the
> cloud-miniapp infrastructure — no app sessions, no heartbeat, no
> webhook routes, no `@mentra/sdk` server protocol. That stuff is
> all in Cloud 1.

But Local SDK miniapps still need **some** cloud surface:

- Speech-to-text and translation run in the cloud (audio is too
  expensive to do on-device). Miniapps subscribe to those streams.
- Photo capture flows through the cloud for upload + signed URLs.
- Managed live streams (Cloudflare-provisioned) need a cloud proxy
  for provisioning + status.

The client team has already built this surface against **cloud v1**
as a hack (branch `mentra-miniapp-sdk-2`, PRs #2767 / #2839 / #2841).
The author described the cloud-side files as "stateless,
copy-pasteable into cloud-2" — but that code hasn't been independently
reviewed for architecture quality, so we treat it as a **rough spike**
that pins down the wire contract, not as code to lift into v2.

This spike maps that surface, captures the routing question (how
mobile chooses v1 vs v2 without a fork in the mobile codebase), and
proposes an order of operations for the v2 build-out.

## Files

- `README.md` — this doc.
- [`spike.md`](./spike.md) — research, concepts primer, prior art
  with file paths, options for mobile routing, open questions.
- [`mobile-local-runtime-liveness.md`](./mobile-local-runtime-liveness.md) —
  Pixel 8 E2E fault note for stale local-miniapp background JSContexts and the
  foreground liveness probe mitigation.
- `spec.md` — **not yet written.** Comes after team discussion of
  the open questions in the spike.
- `design.md` — **not yet written.** Comes after spec lock.

## tl;dr

Three commitments to validate with the team:

1. **Cloud v2 ships exactly three Local SDK surfaces and nothing
   else.** No app sessions, no webhooks, no fan-out registry beyond
   the `__phone__` subscriber pattern.

   - **`__phone__` synthetic session** on the phone WS — accepts
     `PHONE_SUBSCRIPTION_UPDATE`, demuxes transcription/translation
     from the audio service back to the phone. Phone fans out to
     local miniapps in-process.
   - **Photo capture** — `POST /api/client/miniapp-sdk-photo/request`,
     stateless: returns a short-TTL JWT for direct R2 upload; sends
     `PHOTO_REQUEST` to glasses; emits `phone_photo_ready` back on
     the phone WS when the upload lands.
   - **Managed streams** — `/api/v2/client/streams/managed/*`,
     stateless Cloudflare proxy: provision, status, teardown.

   All three exist in v1 on `mentra-miniapp-sdk-2` and define the
   **behavioral contract** v2 must meet — same routes, same wire
   shapes, same observable semantics from the phone's point of view.

   They are *not* a port target. The v1 implementation was built
   quickly as an in-place shim on top of cloud v1's miniapp stack
   and hasn't been independently reviewed for architecture quality.
   Cloud v2 implements these surfaces fresh, with native v2 patterns
   (stateless handlers, Redis pub/sub for cross-service events,
   readiness-gated boot, OEM-scoped sessions where appropriate),
   tested against fixtures derived from v1's wire shapes.

2. **The mobile client does not need to know which cloud it's
   talking to.** The cloud URL is already runtime-configurable
   through the mobile settings store
   (`mobile/src/stores/connection.ts`,
   `mobile/src/services/WebSocketManager.ts:156`). If v2 keeps
   protocol parity with v1 for the three surfaces above, swapping
   the URL is the only change to point a phone at v2.

   Caveat: protocol parity has to be **strict** at the wire level
   for the phone WS message envelopes (`PHONE_SUBSCRIPTION_UPDATE`,
   `phone_photo_ready`, `EVENT { streamType: "stream_status" }`,
   transcription events) and the HTTP routes. If we diverge, mobile
   needs a v1-vs-v2 capability flag and the matrix problem grows.

3. **First milestone: route a single phone end-to-end through
   cloud v2 for transcription only.** Stand up the phone WS in
   `cloud-v2/packages/core` with a `PHONE_SUBSCRIPTION_UPDATE`
   handler and a session-keyed subscription registry, wire the
   existing audio-service transcription stream through to it,
   point a dev phone's `backend_url` setting at the v2 host, and
   verify a local captions miniapp on the phone gets transcripts.
   That validates the routing seam — and the wire-shape parity
   contract — before we tackle photo and streams.

See [`spike.md`](./spike.md) for the open questions and the routing
matrix in detail.
