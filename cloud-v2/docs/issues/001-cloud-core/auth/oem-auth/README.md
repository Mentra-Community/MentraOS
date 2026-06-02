# Cloud v2 Auth

**Status:** Spec under review

## Problem

Cloud v2 needs an auth model that lets OEMs build their own mobile apps,
keep their own user accounts, and have those users call Mentra's backend
services (audio, STT, TTS, AI, miniapp store) without signing in to
Mentra. Today's auth assumes the user signs in to Mentra directly.

## Files

- `README.md`: this doc
- [`spike.md`](./spike.md): research findings, prior art, options
  surveyed, concepts primer
- [`spec.md`](./spec.md): proposal, recommended design, alternatives
  considered, reasoning. **Start here for the proposal.**
- `design.md`: implementation plan. Written after spec is approved.

## tl;dr

Two decisions:

1. **OEM to Mentra auth.** OEM's backend mints short-lived signed tokens
   for each of their users. Client exchanges them with Mentra for a
   Mentra-side session. Modeled after Firebase Custom Auth and
   LiveKit/Twilio/Agora access tokens.

2. **Mentra to miniapp identity.** When Mentra auto-auths a user to a
   miniapp's backend (today's handoff), the payload includes which OEM
   vouched for the user, so miniapp devs can decide their own trust
   policy.

Full reasoning, alternatives considered, and trade-offs in
[`spec.md`](./spec.md).
