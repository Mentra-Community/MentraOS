# Cloud v2 ↔ Local JS SDK Spike

**Status:** Findings + open questions. Not a proposal yet — this doc
exists to brief the team before we lock a spec.

## Why this spike

The client team has been moving developer code off cloud miniapp
servers and onto the phone via the Local JS SDK (`@mentra/miniapp`).
That effort predates cloud v2 and was built against cloud v1 with
the stated intent of being "stateless and portable to cloud-2." The
v1 cloud-side code has not been independently reviewed for
architecture quality, so we treat it as a behavioral reference —
it tells us what wire shapes the mobile already expects — and not
as a port target.

Cloud v2 inherits the new architecture cleanly:
[OS-1446](https://linear.app/mentralabs/issue/OS-1446) defines v2 by
the **absence** of the cloud-miniapp stack (no app sessions, no
heartbeat, no webhooks, no `@mentra/sdk` server protocol).
[OS-1450](https://linear.app/mentralabs/issue/OS-1450) tracks the
formal archival of cloud SDK code and `@mentra/sdk`.

The job of this spike is to map exactly what v1 added for Local SDK,
identify which pieces are "already v2-shaped," and surface the open
question the user raised: **how does the mobile app pick v1 vs v2
without a fork in the mobile codebase?**

## Concepts primer

Terms used throughout. Skim once, refer back as needed.

- **Cloud miniapp (v1).** A third-party developer service running
  outside MentraOS. It connects to cloud v1 over a WebSocket using
  `@mentra/sdk`, declares subscriptions (`transcription`,
  `translation`, …), receives stream events, and sends back display
  commands. This whole model is going away.
- **Local miniapp (v2 model).** A third-party app shipped as a
  static ZIP bundle. Runs in a JS context **on the phone**
  (`LocalMiniappRuntime`). Calls phone-resident APIs:
  `session.camera.takePhoto()`, `session.transcription.subscribe(...)`,
  etc. Does not have a server. Cannot hold long-lived state across
  installs.
- **`__phone__` session.** A *synthetic* cloud-side session
  representing the phone as if it were a cloud miniapp. The phone
  subscribes to cloud streams on behalf of local miniapps using
  this identity. Lets cloud-v1's existing transcription/translation
  fan-out treat the phone like any other subscriber, with one
  bypass: skip the DB permissions check (the phone enforces
  per-miniapp permissions locally).
- **`PHONE_SUBSCRIPTION_UPDATE`.** The wire message the phone sends
  the cloud to update `__phone__`'s subscription set. Distinct from
  a cloud miniapp's subscribe message — different envelope type,
  different routing.
- **Managed stream.** A live video stream where Cloudflare's Stream
  service provisions the ingest endpoint. v1 added a stateless
  cloud route the phone hits to provision a Cloudflare live input.
- **`MantleManager`.** The phone-side dispatcher that routes
  glasses BLE events to either the cloud (for cloud miniapps,
  pre-Local SDK) or the local miniapp runtime. The seam between
  "v1 path" and "v2 path" on the phone.

## v1 prior art — surfaces already built for Local SDK

Everything below is **already in code** on the v1 integration branch
`mentra-miniapp-sdk-2` (draft parent PR
[#2767](https://github.com/Mentra-Community/MentraOS/pull/2767)).

**Treat this as a behavioral spec, not a port target.** The v1
implementation was built quickly to unblock the Local SDK effort
on top of cloud v1's existing miniapp machinery. The cloud-side
files were written with intent to be portable (the author's own PR
descriptions describe them as "stateless, copy-pasteable into
cloud-2"), but they have not been independently reviewed for
architecture quality and we shouldn't take "copy-pasteable" as a
recommendation. What v1 reliably gives us is **the wire contract**:
which routes exist, what request/response bodies they accept and
return, what message envelopes flow over the phone WS, what the
glasses see. Cloud v2 implements these surfaces fresh, in v2's
idiom, and is verified against fixtures captured from v1's wire
behavior.

### 1. `__phone__` synthetic session (cloud-side)

| File | Role |
|---|---|
| `cloud/packages/cloud/src/services/session/AppLikeSession.ts` | Interface implemented by both `AppSession` and `PhoneSession`. Methods: `hasSubscription`, `updateSubscriptions`, `enqueue`, `cleanup`. No lifecycle. |
| `cloud/packages/cloud/src/services/session/PhoneSession.ts` | Synthetic session. Holds subscriptions set + connection state. Does NOT extend `AppSession` — private members blocked structural assignability, hence the interface. |
| `cloud/packages/cloud/src/services/session/SubscriptionManager.ts` | Special-case for `__phone__`: skips the `App.findOne()` DB permission check. Comment in source: *"The `__phone__` subscriber is a PhoneSession, not an AppSession. It skips DB permission checks (phone enforces permissions locally)."* |
| `cloud/packages/cloud/src/services/session/AppManager.ts` | `getOrCreatePhoneSession()` vends the singleton. `sendMessageToApp("__phone__")` routes to the phone WS instead of an app WS. Filters `__phone__` out of user-facing "running apps" state. Rewrites some message types on the way out (`STREAM_STATUS` → `phone_stream_status`). |
| `cloud/packages/cloud/src/services/session/glasses-message-handler.ts` | Handles inbound `PHONE_SUBSCRIPTION_UPDATE` from the glasses/phone WS. |
| `agents/local-app-runtime-plan.md` (Phase 2.5) | Design doc. Phase 2.5 section is the formal spec for this shim. |

**Contract for v2:** there is a synthetic, phone-WS-backed subscriber
that participates in transcription/translation fan-out without going
through any DB-backed app permission model. The shim's *shape* in v1
(an interface implemented by both real-app and phone-stand-in
sessions, plus a special-case branch in the subscription manager)
is one solution. V2 starts from a clean sheet: there are no
`AppSession`s in cloud v2 to share an interface with, so the right
v2 design is probably a `PhoneSessionManager` keyed by user, not an
`AppLikeSession`-shaped polymorphism. We adopt the *behavior*
(phone-WS-backed subscriber, no DB lookup, message rewrites where
needed for parity), not the v1 class layout.

### 2. Photo capture

| File | Role |
|---|---|
| `cloud/packages/cloud/src/services/session/MiniappSdkPhotoManager.ts` | Owns the photo flow per UserSession. `requestPhoto({requestId, packageName, size?, compress?, saveToGallery?, sound?})` mints a JWT R2 upload token, sends `PHOTO_REQUEST` to glasses with `{webhookUrl, authToken, ...params}`. |
| `cloud/packages/cloud/src/api/.../miniapp-sdk-photo.api.ts` | `POST /api/client/miniapp-sdk-photo/request` (phone calls). R2 upload completion → `handleUploadComplete(requestId, photoUrl, mimeType, size)` → emits `phone_photo_ready` over the phone WS. |
| `mobile/src/services/miniapp/MiniappSdkPhotoHandler.ts` | Phone-side dispatcher for `session.camera.takePhoto()`. POSTs to `/api/client/miniapp-sdk-photo/request`, then waits for `phone_photo_ready` on the WS. |

**Contract for v2:** the phone POSTs a `requestPhoto` with size /
compress / saveToGallery / sound; gets back an acceptance and a
request ID; the cloud orchestrates glasses → R2 → signed-URL
delivery via `phone_photo_ready` on the phone WS. The v1 manager's
in-memory pending map and TTL are reasonable defaults but not a
contract — v2 can keep this in core's process memory (small,
volatile, fine to lose on restart) or move it behind Redis if we
want cross-instance redundancy. The glasses message envelope
(`PHOTO_REQUEST`) is shared with `asg_client` and *is* a contract —
we don't change its shape. R2 + JWT signing keys need Doppler
entries in v2's config; that's plumbing, not design.

### 3. Managed streams

| File | Role |
|---|---|
| `cloud/packages/cloud/src/api/hono/client/v2/streams.api.ts` | `POST /provision`, `GET /:liveInputId/status`, `DELETE /:liveInputId`. **Explicitly stateless** — source comment: *"Stateless Cloudflare-Stream proxy for phone-orchestrated managed live inputs. Each request is a one-shot pass to CloudflareStreamService — no registry, no lifecycle timers, no WebSocket emissions, no DB writes."* |
| `mobile/src/services/streaming/PhoneStreamCoordinator.ts` | Phone-side coordinator. Owns the one-stream-at-a-time constraint, multi-miniapp sharing of managed streams, refcounted teardown. |
| `mobile/src/services/streaming/StreamLifecycleController.ts` | Heartbeat/ACK/escalation state machine. *Parity copy* of the cloud-v1 version — comments warn behavior changes must mirror cloud. (Open question: does cloud v2 ship a copy too, or do we delete the cloud copy entirely now that streams are phone-owned?) |
| `agents/stream-local-js-sdk-plan.md` | Design doc for PR #2841. Captures the poll-vs-WS decision for Cloudflare status, restream-destination immutability, the cloud route path. |

**Contract for v2:** three routes, three Cloudflare API calls. This
is the surface with the smallest contract surface area and the most
self-contained dependencies — a small Cloudflare REST wrapper plus
a per-process owner map. V2 reimplements it cleanly; "copy-paste" is
the v1 author's framing, not ours. The only thing v2 inherits as
contract is the route paths, request/response body shapes, and the
ownership rule (an `liveInputId` can only be inspected or torn down
by the user who provisioned it).

### Session surfaces — what needs the cloud, and what doesn't

Local SDK session modules and their cloud dependency:

| Module | Cloud needed? | If yes, what |
|---|---|---|
| `session.transcription` | yes | `__phone__` session + audio stream |
| `session.translation` | yes | `__phone__` session + audio stream |
| `session.mic` | yes (raw chunks if subscribed) | `__phone__` session + audio stream |
| `session.camera` | yes | photo capture route |
| `session.stream` | yes (managed only) | managed-streams route |
| `session.location` | no | phone GPS |
| `session.dashboard` | no | phone-local |
| `session.display` | no | phone → glasses BLE |
| `session.events` | no (subscription registry only) | phone-local fan-out |
| `session.glasses` | no | phone-local |
| `session.heading` | no | phone IMU |
| `session.imu` | no | phone IMU |
| `session.input` | no | glasses BLE |
| `session.led` | no | glasses BLE |
| `session.navigation` | no (uses phone Google Nav SDK) | phone-local |
| `session.permissions` | no | phone manifest |
| `session.phone` | no | phone OS |
| `session.speaker` | no | glasses BLE |
| `session.storage` | no | phone AsyncStorage |
| `session.system` | no | phone OS |
| `session.ui` | no | postMessage bridge |

**Cloud v2 surface for Local SDK = exactly three things:** the
`__phone__` subscriber, photo capture, managed streams.

## Cloud v2 current state

Where v2 is today, for orientation:

- `packages/core` — Hono server (`:3000`), OEM auth (RFC 8693 token
  exchange), Mongo + Redis connections, `/healthz` + `/ready`. **No
  phone WebSocket yet.** No `PHONE_SUBSCRIPTION_UPDATE` handler.
- `packages/runtime` — UDP ingress (`:8000`), LC3 decode workers,
  Soniox provider, ownership in Redis. Transcripts already get fanned
  out internally — there's no consumer wired up yet (it's pushed
  into the audio WS as `TRANSCRIPT` messages for the test client).
- `packages/proxy` — stub.
- Deployed in AWS us-west-2 (Porter + NLB for UDP, ElastiCache,
  Atlas). End-to-end tested with real Soniox via
  `scripts/soniox-smoke.ts`.

## Routing question — how does mobile pick v1 vs v2?

The user raised this explicitly: *"ideal if we don't have to make
any mobile clients changes but if we do then we'll have to make them
minimal and we'll also have to make them either match Cloud V1 match
or the mobile client to be aware if it's talking to Cloud V1 or
Cloud V2."*

### What the mobile client knows today

- The cloud base URL is **already runtime-configurable** via the
  Zustand settings store
  (`mobile/src/services/WebSocketManager.ts:156` reads
  `useSettingsStore.getSetting(SETTINGS.backend_url.key)` fresh on
  every connection attempt).
- The mobile client does **not** know about miniapps directly —
  it streams audio, receives display commands, forwards subscription
  updates from the local runtime, doesn't run any app code.
- All the Local SDK ↔ cloud calls the phone makes go through three
  surfaces: the phone WS (subscriptions + stream events), the photo
  HTTP route, and the managed-streams HTTP route.

### Options

**Option A — protocol parity at the wire level. Mobile is
cloud-agnostic.**

V2 ships the three surfaces with identical paths, message envelopes,
and semantics to v1. Mobile picks the cloud by URL only; nothing
else changes. Engineer points a dev phone at the v2 host by changing
the setting.

- ✅ Zero mobile-code changes.
- ✅ Easiest dev/staging story (per-device toggle).
- ✅ Doesn't fork the mobile codebase.
- ⚠️ V2 has to match v1's wire shapes exactly, even for things v2
  might want to redesign. Any divergence breaks parity.
- ⚠️ When v1 is finally archived, "support both" goes away
  automatically — but until then, v1 must not drift either.

**Option B — capability negotiation on connect.**

Mobile WS-connects, cloud responds with `server_hello` declaring
capabilities + version. Mobile gates per-feature based on the
response. Lets v2 deviate on shapes where it wants to.

- ✅ Allows divergence where v2 has a better design.
- ⚠️ Adds a real handshake to the phone WS lifecycle. Today
  there's a `connection_init` from the phone; the response is
  thin. Would need an envelope.
- ⚠️ Spreads conditional logic through the mobile codebase. Hard to
  audit, easy to leave a v1-only branch behind when v1 archives.

**Option C — runtime config flag, no wire negotiation.**

Mobile reads `cloudVersion` from the same settings store. SDK
modules choose code paths per flag.

- ✅ Simple.
- ⚠️ Couples the mobile codebase to the cloud version explicitly.
  Branches in `MiniappSdkPhotoHandler`, `PhoneStreamCoordinator`,
  the WS demux, etc. Same audit and cleanup cost as B.
- ⚠️ If a user accidentally sets `cloudVersion=v2` but
  `backend_url` still points at v1, breakage is silent.

### Recommended direction (for team discussion)

**Adopt Option A.** Make v2's three surfaces wire-identical to v1's.
Concretely:

- Phone WS endpoint, `connection_init` envelope, and
  `PHONE_SUBSCRIPTION_UPDATE` handler: same path, same shape.
- Transcription/translation event envelopes pushed to the phone:
  same shape as v1.
- Photo: `POST /api/client/miniapp-sdk-photo/request` same path,
  same request/response body, `PHOTO_REQUEST` to glasses
  unchanged, `phone_photo_ready` over phone WS same envelope.
- Managed streams: same `/api/v2/client/streams/managed/*` paths,
  same body shapes.

Then dev/staging routing is "change the URL," prod cutover is per-
user (or per-region) at the URL/DNS layer (Cloudflare LB rule,
phased rollout), and we never write `if (cloudV2)` in the mobile
code. When v1 archives, nothing in mobile needs to change.

Risks to watch:
1. **Audio stream format.** v2 audio ships transcripts as a different
   message shape on its internal WS today (`TRANSCRIPT { kind, text,
   language, isFinal }`). v1's `__phone__` flow pushes transcription
   events using v1's transcription stream envelope. We need to
   reshape inside v2's `__phone__` handler so what hits the phone WS
   is byte-for-byte the v1 envelope. Cheap, but a real translation
   layer.
2. **Auth.** v1 uses CoreToken on the phone side. v2 has OEM-attested
   JWTs (RFC 8693). The phone WS in v2 needs to accept both, or
   normalize to one. Open question.
3. **Drift over time.** Need a parity test: a shared fixture of v1
   wire shapes that v2 must round-trip. Lives in `cloud-v2/tests/`,
   imports types/shapes from a v1 archive in this repo (or a copy)
   so we get a compile/test break if anything diverges.

## Build order (proposal — discuss)

Each step is a **fresh v2 implementation** measured against the v1
wire contract. Where v1's design choice is good, v2 takes it
deliberately; where v1's design is incidental, v2 picks its own.

1. **Capture the v1 wire contract as a fixture set.** Pull v1's
   request/response bodies, WS envelopes, and message-type enums
   from `mentra-miniapp-sdk-2` into `cloud-v2/tests/v1-contract/`
   as JSON fixtures (not code imports). These fixtures are what
   v2 round-trips against; v1 source code is reference, not a
   dependency.
2. **Phone WS endpoint + subscription registry in `packages/core`.**
   Accept `connection_init`, accept `PHONE_SUBSCRIPTION_UPDATE`,
   maintain a `PhoneSessionManager` keyed by user. Subscriptions
   in-memory by default; revisit Redis-backing in OQ2 below if
   cross-instance is required.
3. **Core ↔ audio transcription bridge.** Audio already produces
   transcripts internally. Add Redis pub/sub (or whatever channel
   we land on) so core can subscribe per-user and forward to the
   phone WS. Reshape the audio service's internal transcript
   envelope to match v1's phone-WS transcription envelope at the
   adapter layer — the audio service's internal shape stays clean,
   the v1-shape lives at the v2 boundary.
4. **End-to-end test on a dev phone.** Setting `backend_url` = v2,
   install a local captions miniapp, verify transcripts appear.
   This is the milestone that proves the routing seam works.
5. **Photo capture surface.** Implement `requestPhoto` HTTP route
   + glasses messaging + R2 upload completion handler. Reshape
   R2 credentials and JWT signing as v2-native config (Doppler).
6. **Managed streams surface.** Implement the three Cloudflare
   proxy routes natively. The Cloudflare REST integration is the
   one piece worth lifting verbatim — it's a thin API wrapper.
7. **Mic raw-chunk subscription.** (Spike. Lower priority —
   captions doesn't need it.)
8. **Archive v1's cloud-miniapp code** ([OS-1450](https://linear.app/mentralabs/issue/OS-1450)).
   Independent of v2 cutover; can happen once cutover is complete.

## Open questions (for team review)

1. **Auth on the phone WS in v2.** CoreToken (v1) vs. OEM-attested
   JWT (v2). One or both? If both, what's the resolution rule?
2. **Where does the `PhoneSession` registry live?** Core only? Or do
   we expose it via Redis so audio can publish-by-subscription
   directly without going through core?
3. **Permissions enforcement.** v1's `SubscriptionManager` bypass
   says "phone enforces locally." Do we want a defense-in-depth
   check on the cloud side too, or trust the phone's manifest
   enforcement?
4. **Parity-test strategy.** Do we vendor a snapshot of v1's
   relevant types into `cloud-v2/test/v1-parity/` and assert
   round-trip equality, or keep a hand-written fixture set?
5. **Streaming control loop.** v1's `StreamLifecycleController` has
   a phone copy and (until 2841 merges) a cloud copy. Does cloud v2
   keep a copy, or is it phone-only for v2?
6. **When does `mentra-miniapp-sdk-2` stabilize?** v2 doesn't port
   from it, but v2's wire-contract fixtures (step 1) snapshot from
   it. If the wire shapes are still in flux on that branch we need
   a snapshot point we both agree on, or the parity test becomes a
   moving target. Coordinate with Matt on a "this is the contract"
   commit SHA.
7. **OEM scope.** Are Local SDK miniapps OEM-scoped on cloud v2 the
   way OEM auth scopes users today? Or is OEM a user-level concept
   and miniapps are global?

## References

- Linear project: [Local SDK](https://linear.app/mentralabs/project/local-sdk-b55345e6ccda)
- Linear tickets: [OS-1297](https://linear.app/mentralabs/issue/OS-1297)
  (`__phone__` session), [OS-1436](https://linear.app/mentralabs/issue/OS-1436)
  (photo), [OS-1437](https://linear.app/mentralabs/issue/OS-1437)
  (managed streams), [OS-1446](https://linear.app/mentralabs/issue/OS-1446)
  (cloud-v2 deploy = no cloud SDK), [OS-1450](https://linear.app/mentralabs/issue/OS-1450)
  (archive cloud SDK)
- PRs: [#2767](https://github.com/Mentra-Community/MentraOS/pull/2767)
  (parent draft, `mentra-miniapp-sdk-2`),
  [#2839](https://github.com/Mentra-Community/MentraOS/pull/2839)
  (phone VAD + local STT routing, MERGED),
  [#2841](https://github.com/Mentra-Community/MentraOS/pull/2841)
  (phone-streamed managed streams + photo + tester pages, OPEN)
- Plan docs (in v1 branch): `agents/local-app-runtime-plan.md`
  (Phase 2.5 spec), `agents/stream-local-js-sdk-plan.md` (streams)
