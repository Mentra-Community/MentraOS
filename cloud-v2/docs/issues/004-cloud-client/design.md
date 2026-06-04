# Cloud Client: implementation design

**Status:** Design, ready to build against. This is how `@mentra/cloud-client` works
behind the public API: the three modules (`cloud.auth`, `cloud.runtime`,
`cloud.core`), the pieces that get passed in per platform, and the mechanics behind
each method (connecting, refreshing tokens, reconnecting, sending audio). The public
API is in [`spec.md`](./spec.md); the system picture and the decisions are in
[`architecture.md`](./architecture.md). This doc is the build plan.

**TL;DR:** One `CloudClient` object owns the server addresses, the login state, and a
small HTTP helper, and builds three modules on top. `cloud.auth` gets and refreshes
the access token and mints per-miniapp tokens. `cloud.runtime` keeps the live
WebSocket open, sends subscriptions over REST, and turns every incoming message into
a typed event. `cloud.core` makes the remaining one-off REST calls. The phone-only
pieces (the WebSocket, the UDP socket, secure storage) are passed in, so the same
core code runs on the phone and on a server.

## Package layout

The package is split so platform-only code never leaks into the shared core:

- `@mentra/cloud-client/core`: all the logic. No phone-only or browser-only
  imports. Takes the platform pieces as inputs.
- `@mentra/cloud-client/react-native`: a thin wrapper that supplies the phone's
  WebSocket, UDP socket, and secure storage, then re-exports `CloudClient`.
- `@mentra/cloud-client/node`: the same wrapper for a server, a Node WebSocket, a
  `dgram` UDP socket, and an in-memory or file-backed store. This build is what the
  test harness uses.

Everything below lives in the core unless it says otherwise.

## The pieces passed in per platform

Three things differ between a phone and a server, so the core takes them as inputs
instead of importing them (the types are in [`spec.md`](./spec.md#construction)):

| Input | What it is | On the phone | On a server |
| --- | --- | --- | --- |
| `ws` | opens a WebSocket and sends/receives text | the RN WebSocket (or nitro-websockets later) | the `ws` package |
| `udp` | sends and receives UDP packets | a native socket | Node `dgram` |
| `storage` | a tiny key/value store for tokens | the OS secure store | memory or a temp file |

REST is the exception: there's no platform input for it, because `fetch` exists on
both a phone and a modern server. The core calls `fetch` directly.

## The top-level `CloudClient`

`new CloudClient(config)` does the wiring and nothing else clever:

- Holds the server addresses (`endpoints.core`, `endpoints.runtime`, and an optional
  `endpoints.proxy`). If a proxy is set, both the core and runtime addresses are
  rewritten to go through it.
- Builds a small **HTTP helper** (next-to-last section) that every module uses for
  REST: it adds the `Authorization: Bearer` header, parses JSON, and maps errors.
- Builds `cloud.auth` first (the other two depend on it for the token), then
  `cloud.runtime` and `cloud.core`.
- Owns logging and the reconnect/backoff settings, so there's one place to tune them.

## `cloud.auth`

The one owner of credentials. It holds the access token in memory, persists the
refresh token through the `storage` input, and never hands the access token to a
miniapp (see [`architecture.md`](./architecture.md) section 6).

**Getting the first token.** It's constructed with a **subject token** (the OEM's
signed JWT, or a Mentra core token / Supabase session, or a `getSubjectToken()`
callback that fetches one). On first use it calls `POST /api/client/auth/exchange`
with that subject token and gets back an access token (good for ~1h) and a refresh
token, which it saves.

**`getAccessToken()`** (used internally by `cloud.runtime` and `cloud.core` before
every call):

1. If the cached access token is still valid (with a small safety margin, say 60s),
   return it.
2. Otherwise refresh: call `POST /api/client/auth/refresh` with the stored refresh
   token, save the new access token and the new (rotated) refresh token, return the
   new access token.
3. If two callers ask at once, only **one** refresh request goes out and both get its
   result (a single-flight lock). Without this, a reconnect storm would fire many
   refreshes at once.
4. If refresh fails (the refresh token is dead or revoked), fire the `onExpired`
   handler so the host can send the user back through login. Don't retry forever.

**`getMiniappToken(packageName)`:** calls `POST /api/client/auth/miniapp-token` with
the access token as the Bearer, and caches the result per packageName with its
expiry. A second call for the same packageName returns the cached token until it's
near expiry, then re-mints (single-flight, same as above). This is what the on-device
runtime calls at miniapp launch and on refresh.

**`identity`:** the access token is a JWT, so its claims (`sub = mentraUserId`,
`oemId`) are just base64 JSON inside it. `identity` reads them straight off the token
it already holds. It does **not** verify the signature: the client isn't a security
boundary for its own token, the cloud verifies on every call.

**What's persisted:** the refresh token (so a relaunch doesn't force a new login).
The access token can stay in memory and be re-minted from the refresh token on
startup.

## `cloud.runtime`

The live session: one WebSocket, plus REST for anything the client initiates. It
implements the locked protocol in
[`../002-cloud-runtime/protocol.md`](../002-cloud-runtime/protocol.md).

**Connecting (`connect()`):**

1. Open the WebSocket to `endpoints.runtime`, with the access token in the first
   frame (the `?token=` URL fallback is there for the Chrome debugger).
2. Send a `connection.init` message: the protocol version, the platform, and the
   audio config (codec, sample rate, and any initial subscriptions so audio that
   starts immediately isn't transcribed against an empty set).
3. Wait for the cloud's `connection.ack`. It carries the `sessionId` (used on REST
   calls) and, when UDP audio is available, the `sessionTag`, the UDP host/port, and
   the per-session encryption key. Save all of it. Now the session is ready.
4. If the cloud replies with a fatal `error` instead (bad or expired token), surface
   it; for `AUTH_EXPIRED`, refresh through `cloud.auth` and reopen.

**Staying connected:**

- **Reconnect with backoff.** If the socket drops, reconnect with an exponential
  delay plus a little randomness (so a fleet of phones doesn't reconnect in lockstep).
  On every successful reconnect, redo the handshake and **re-send the full
  subscription set** at the current version, because the cloud may have a fresh
  session.
- **Liveness.** The client sends a `control.ping` every N seconds and expects a
  `control.pong`. No pong in time means the connection is dead even if the socket
  looks open, so reconnect. (The cloud stays passive on liveness; the client owns
  reconnect.)

**Incoming messages.** Every WebSocket message is parsed and checked against the
shared `cloudToClientMessage` definition from `@mentra/cloud-runtime/protocol` before
anything acts on it. A message that doesn't match is dropped with a log, not crashed
on. A valid one is handed to the typed event emitter (below). An unknown `type` is
non-fatal by the protocol, so it's logged and ignored.

**The event emitter.** Under the hood there's one typed emitter keyed by an event map
(`RuntimeEvents`). The friendly methods (`onTranscript`, `onTranslation`,
`onConnected`, ...) and the generic `on(event, cb)` / `onAny(cb)` are thin wrappers
over it, so there's one source of truth and no event-name strings to mistype. Every
subscribe call returns an unsubscribe function.

**Subscriptions (`setSubscriptions(subs)`):** this is a REST call, not a WebSocket
message, so any pod can serve it. It sends
`PUT /api/audio/subscriptions { subscriptions, sessionId, version }`:

- `subscriptions` is the full desired set as typed `AudioSubscription[]` (full
  replace, not a diff).
- `version` is a counter the client bumps on every change, so an out-of-order arrival
  at the cloud is ignored.
- `sessionId` is the one from `connection.ack`, so the cloud ties the update to this
  session.

**Managed photo and stream:** the client sends a REST request and then waits for a
matching WebSocket push. `requestManagedPhoto()` sends the request, records it by
`requestId`, and resolves the promise when the `photo.ready` push with that
`requestId` arrives (rejecting on `photo.error` or after a timeout). `startManagedStream()`
is the same shape over the stream endpoints.

**UDP audio:** the audio bytes never touch the JavaScript layer. From
`connection.ack.audio` the runtime has the `sessionTag`, the UDP host/port, and the
encryption key. It encrypts each frame **in the core** (NaCl secretbox / tweetnacl,
so it's identical on phone and server and testable on a server) into the frame
`[ sessionTag(4) | seq(2) | nonce(24) | ciphertext ]`, and the injected `udp`
transport just sends the bytes. On the WebSocket audio fallback there's no UDP and no
secretbox key; the frames ride the per-user WebSocket, which is already encrypted.

## `cloud.core`

The simplest module: stateless REST calls, each with the access token from
`cloud.auth.getAccessToken()`. No connection, no session state, so any pod serves it.
`miniapps.list()` and `miniapps.getBundle()` are `GET`s that return typed results. It
grows as miniapp-service is specced.

## The shared HTTP helper

All three modules make REST calls through one small helper so the behavior is
consistent:

- Resolves the base address (proxy-aware) and builds the URL.
- Adds `Authorization: Bearer <access token>` from `cloud.auth` (except the
  `/exchange` call, which presents the subject token instead).
- Sends and parses JSON, and maps a non-2xx response to a typed error the caller can
  branch on (for example, a 401 from a resource call triggers one refresh-and-retry
  through `cloud.auth`).
- Retries only safe, idempotent calls (`GET`, the full-replace `PUT`) on a transient
  network error, with a small backoff.

## How auth and the live connection interact

The access token expires (~1h) while a session can last much longer, so the two
modules cooperate:

- `cloud.runtime` and `cloud.core` always get the token through
  `cloud.auth.getAccessToken()`, which refreshes transparently when it's near expiry.
- If the cloud rejects the live socket with `AUTH_EXPIRED` anyway (clock skew, a
  revoke mid-session), `cloud.runtime` asks `cloud.auth` to refresh, then reopens with
  the new token.
- If the refresh itself fails, `cloud.auth.onExpired` fires once and the host decides
  what to do (usually: send the user back through login).

## Errors and logging

- Protocol errors arrive as the typed `ProtocolError` (`code`, `message`, `fatal`).
  Fatal ones close the socket (the cloud closes it; the client then reconnects or, for
  auth, refreshes first). Non-fatal ones surface through `onError` and the connection
  stays up.
- One logger is owned by `CloudClient` and passed down, so a host can route
  cloud-client logs wherever it wants. Tokens are never logged.

## Implementation order

Build it so the test harness works as early as possible:

1. The transport interfaces + the **node** implementations (so everything is testable
   on a server from day one), and the shared HTTP helper.
2. The `CloudClient` skeleton (endpoints, proxy rewrite, logger).
3. `cloud.auth`: exchange, refresh (single-flight), `getMiniappToken`, `identity`,
   `onExpired`, persistence.
4. `cloud.runtime`: the handshake, the typed emitter, `setSubscriptions`, reconnect,
   liveness.
5. Managed photo/stream, then the UDP audio path.
6. `cloud.core`.
7. The **react-native** transport implementations.

## Proposals carried from `architecture.md`

These are the still-open choices, with the proposed direction (full reasoning in
[`architecture.md`](./architecture.md) section 10):

- Inject `cloud.runtime` directly as the on-device runtime's `cloud` hook, with no
  separate adapter layer to keep in sync.
- Pick the v1-vs-v2 transport in one place at boot, defaulting to v2 for the v2 cloud.
- Do the UDP encryption in the shared core (above), with the native side doing only
  the send/receive.
