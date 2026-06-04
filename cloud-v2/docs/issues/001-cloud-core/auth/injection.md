# Proposal: miniapp token injection (on-device)

**Status:** Design proposal. How the on-device Mentra Runtime delivers the
miniapp-scoped token to a running miniapp and refreshes it, so the miniapp can
call its developer backend. The token, the mint endpoint, and JWKS are specced in
[`./spec.md`](./spec.md); the end-to-end flow is in [`spike.md`](./auto-auth.md).
This doc is the client-side delivery half.

## Principle

The miniapp receives only the **miniapp-scoped token** (`aud = <packageName>`,
short-lived, verifiable by the developer backend via JWKS). The user's Mentra
access token stays in the cloud-client and is never handed to a bundle. The
Runtime obtains the scoped token from `cloud.auth.getMiniappToken(packageName)`
and delivers it into the bundle.

## A miniapp runs in two JS contexts

The Mentra Runtime executes a bundle in a WebView (UI) and the Crust engine
(JavaScriptCore / QuickJS, headless logic). A call to the developer backend can
originate from either, so the token must be available in both. Both receive the
**same** token from the same Runtime-held source.

## Delivery

At launch the Runtime mints the token and delivers it over the existing
host-to-bundle bridge:

- **Identity + initial token on connect.** The connect handshake the SDK performs
  (`session.connect()`) returns, alongside the session info, `mentraUserId` and
  the initial miniapp token. So the developer code has both as soon as the session
  is ready.
- **WebView.** The token is delivered through the runtime bridge (the same channel
  that pushes events to the page). `@mentra/react` `useMentraAuth()` reads
  `{ mentraUserId, token }` from it. On the web fallback (a webview opened outside
  the app), the "Sign in with Mentra" OAuth flow ends with the same token, so
  `useMentraAuth()` is identical either way.
- **Crust engine.** The local SDK running in the headless context receives the
  token from the Runtime host via the engine bridge and exposes the same
  `{ mentraUserId, token }` plus an authed-fetch helper.

## Refresh

The scoped token is short-lived. The Runtime re-mints it before expiry (via
`cloud.auth.getMiniappToken`, which caches and refreshes per packageName) and
pushes the new token to both contexts through a dedicated auth-update message. The
SDK swaps it in transparently, so in-flight and subsequent dev-backend calls carry
a valid token.

## Using it

```ts
// developer's miniapp (web or headless), via the SDK
const { mentraUserId, token } = useMentraAuth()           // or the local SDK equivalent
await fetch("https://api.theirapp.com/...", {
  headers: { Authorization: `Bearer ${token}` },
})
```

The developer backend verifies the token against Mentra's JWKS, checks
`aud == its packageName`, and applies its trust policy on `oemId` (per oem-auth
Q2). No call back to Mentra per request.

## Open points

The token, mint endpoint, and JWKS are specced; this doc proposes the on-device
delivery shape. Still to finalize: the precise auth-update message format on each
bridge (the WebView channel and the Crust engine bridge), and whether
`useMentraAuth()` and the local SDK share one implementation.
