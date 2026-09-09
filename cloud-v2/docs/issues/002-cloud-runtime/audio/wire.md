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
PUT /api/audio/subscriptions
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "subscriptions": AudioSubscription[],   // canonical type, see spec.md
  "sessionId": string,                     // from connection.ack; writes from a stale session are ignored
  "version": number                        // monotonic per snapshot; older versions discarded
}
```

Full-set replace. `sessionId` + `version` exist because of the legacy scars
(out-of-order application, and an empty snapshot after reconnect wiping a live
set). The server ignores writes whose `sessionId` is not the current session and
discards out-of-order versions, and replies with an ack carrying any `rejected[]`
entries (for example an unsupported language). An empty set is honored only when
it is the latest version for the current session, so a stale empty cannot wipe a
live set.

This REST endpoint is the decided transport (Option 2a): the cloud delivers the
change to the owning worker as a control entry in the user's audio stream, with no
pub/sub. REST was chosen over putting subscriptions on the WebSocket so the client
gets request/response, acks, and retries, and so the WebSocket stays mostly a
downstream push channel.

### Server-side routing (informative)

Implementation guidance, not wire contract. The Option 2a routing: REST, delivered
to the owning worker through the user's audio stream, no pub/sub.

- The authoritative subscription set lives in a Redis key hash-tagged
  `{user:X}` (matching the audio stream and ownership keys), holding the full set
  plus the last accepted `sessionId`/`version`. A stale `sessionId` or older `version` is
  rejected, so a retried or reordered write cannot clobber a live set.
- The REST handler (any pod) writes the key, then `XADD`s a `subscriptions-changed`
  control entry into the user's existing `{user:X}:audio` stream. The owning
  worker already runs `XREADGROUP` on that stream, so it gets the entry in order
  with audio, on the same shard, with `XAUTOCLAIM` failover replay. No pub/sub.
- `connection.init.audio.initialSubscriptions` seeds this key atomically with
  session creation, closing the cold-start gap.
- The control entry is a nudge; the key is the source of truth. The worker
  reconciles from the key on the entry, on startup, and on ownership acquisition,
  never off the entry payload alone.
- The worker computes its provider set from the full subscription set each time.
  No derived caches across the boundary (legacy proved those drift).

Two implementation choices are still open: whether the control entry goes in the
`{user:X}:audio` stream or a dedicated `{user:X}:control` stream (lean: a dedicated
control stream, so the worker doesn't branch on entry type inside the audio path),
and the subscription key's lifetime (a TTL refreshed by the owner, an explicit delete
on clean disconnect, or both).

## Push events (cloud to client)

WebSocket envelope messages (see [`../protocol.md`](../protocol.md#envelope)):

| type                 | payload                          |
| -------------------- | -------------------------------- |
| `stream.transcript`  | `TranscriptionData` (see spec.md)|
| `stream.translation` | `TranslationData` (see spec.md)  |

## UDP audio frames

Binary frames sent to the advertised `connection.ack.audio.udp` host and port:

```
offset 0   u32   sessionTag   (from connection.ack.audio.sessionTag, big-endian)
offset 4   u16   seq          (per-session packet counter)
offset 6   [24]  nonce        (random per packet)
offset 30  ...   ciphertext   (encrypted LC3 + 16-byte Poly1305 tag)
```

The header (`sessionTag`, `seq`) is in the clear because the stateless ingress
needs it to route the datagram to the right session. Only the audio payload is
encrypted and authenticated. The cloud accepts LC3; PCM is reserved for future
codecs negotiated in `connection.init.audio.codec`.

## Encryption

UDP audio is encrypted with **NaCl secretbox (XSalsa20-Poly1305)**, carried
forward from the retired V1 transport and its mobile crypto implementation.

- The cloud generates a **per-session 32-byte symmetric key** and delivers it in
  `connection.ack.audio.encryption.key` (base64), over the TLS WebSocket, so the
  key never travels over UDP. A new connection means a fresh key (rotation for
  free).
- The client encrypts each frame's payload with that key and a fresh random
  24-byte nonce: `secretbox(LC3, nonce, key)` produces the ciphertext plus a
  16-byte Poly1305 tag. Overhead is 40 bytes per packet (24 nonce + 16 tag).
- The cloud decrypts with the same key, authenticating the tag (tampered or
  forged packets are rejected).

The runtime decrypts at ingress (`services/session/stream.ts`): the per-session key
is fetched by `sessionTag` (the in-process session map on the same pod, or the Redis
sessionTag registry for a cross-pod packet) and used to open the secretbox. A frame
that fails the Poly1305 tag is dropped, not stored. The WS-binary fallback carries
plaintext, since it rides the TLS WebSocket.

## What this replaces

The runtime package used to carry a v1 phone-contract adapter
(`wire/phone-protocol.ts`: `phone_subscription_update` inbound, `data_stream`
outbound) so the unchanged legacy mobile could reach cloud-v2. That adapter has been
removed: the v2 path now emits `stream.transcript` / `stream.translation` and takes
subscriptions over REST. With `@mentra/cloud-client` owning the v2 path, the legacy
miniapp system stays on the v1 cloud over its own connection. The `?token=` query
mechanism is the only piece carried forward, as the documented auth fallback in
[`../protocol.md`](../protocol.md#auth-and-handshake).
