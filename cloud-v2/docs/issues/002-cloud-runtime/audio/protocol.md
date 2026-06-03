# Audio service wire protocol

The audio service's wire surface, built on the runtime transport
([`../protocol.md`](../protocol.md)). It defines the subscription REST endpoint,
the transcript and translation push events, and the UDP audio frame format.

The subscription and result **data models are canonical in
[`spec.md`](./spec.md)** and are not redefined here. This doc only specifies how
those types move on the wire.

## Data model (canonical, see spec.md)

- **Subscriptions:** `AudioSubscription`, a discriminated union of
  `TranscriptionSubscription` and `TranslationSubscription`, built on
  `LanguageSource` (`specific` with a `code`, or `auto` with optional `hints`).
  See [`spec.md`](./spec.md#subscription-model). Identity is structural after
  canonicalization (for example sorting `hints[]`). Full-set replace, not deltas.
- **Results:** `TranscriptionData` / `TranslationData`. See
  [`spec.md`](./spec.md#result-types).

## Subscription REST endpoint

```
PUT /v2/runtime/audio/subscriptions
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "subscriptions": AudioSubscription[],   // canonical type, see spec.md
  "epoch": string,                         // per-connection/session; stale epochs ignored
  "version": number                        // monotonic per snapshot; older versions discarded
}
```

Full-set replace. `epoch` + `version` exist because of the legacy scars
(out-of-order application, and an empty snapshot after reconnect wiping a live
set). The server ignores writes from a stale epoch and discards out-of-order
versions, and replies with an ack carrying any `rejected[]` entries (for example
an unsupported language). An empty set is honored only when it is the latest
version for the current epoch, so a stale empty cannot wipe a live set.

Whether subscriptions flow over this REST endpoint or over the WebSocket is an
open decision: see [`subscription-transport.md`](./subscription-transport.md).
The endpoint here is the REST option; the data model and guards are the same
either way.

### Server-side routing (informative)

Implementation guidance, not wire contract.

- The authoritative subscription set lives in a Redis key hash-tagged
  `{user:X}` (matching the audio stream and ownership keys), holding the full set
  plus the last accepted `epoch`/`version`.
- `connection.init.audio.initialSubscriptions` seeds this key atomically with
  session creation, closing the cold-start gap.
- The key is the source of truth; any cross-pod signal to the owning worker is
  only a nudge. The worker reconciles from the key on the nudge, on startup, and
  on ownership acquisition, and never reconciles off a nudge payload alone.
- The worker computes its provider set from the full subscription set each time.
  No derived caches across the boundary (legacy proved those drift).

## Push events (cloud to client)

WebSocket envelope messages (see [`../protocol.md`](../protocol.md#envelope)):

| type                 | payload                          |
| -------------------- | -------------------------------- |
| `stream.transcript`  | `TranscriptionData` (see spec.md)|
| `stream.translation` | `TranslationData` (see spec.md)  |

## UDP audio frames

Binary frames sent to the advertised `connection.ack.audio.udp` host and port:

```
offset 0  u32  sessionTag   (from connection.ack.audio.sessionTag, big-endian)
offset 4  u16  flags/seq    (reserved)
offset 6  ...  payload      (LC3 audio for real glasses)
```

The cloud accepts LC3. PCM is reserved for future codecs negotiated in
`connection.init.audio.codec`. The v1 packet header (session id, encryption,
sequence) is carried forward unchanged; see [`design.md`](./design.md) and the
v1 UDP audio encryption work.

## What this replaces

The current `@mentra/audio` package speaks the v1 phone contract
(`phone-protocol.ts`, `phone_subscription_update` inbound, `data_stream`
outbound, `?token=` query auth) so the unchanged legacy mobile could reach
cloud-v2. With the new client module owning the v2 path, the legacy miniapp
system stays on v1 cloud over its own connection, so that adapter is removed from
the v2 path during the `audio` to `runtime` rename. The `?token=` query mechanism
is the only piece carried forward, as the documented auth fallback in
[`../protocol.md`](../protocol.md#auth-and-handshake).
