# Audio service

The live transcription and translation path: it turns a user's audio into transcripts
and translations and pushes them back over the WebSocket. This is the stateful core of
the runtime, with the ownership and failover machinery, because a live transcription
session has to survive failures without a gap in the words.

For the plain-language big picture (how the runtime scales, a session's life across
pods, an end-to-end trace), read [`../architecture.md`](../architecture.md). This
folder is the audio service in depth.

## Files

- [`spec.md`](./spec.md): the architecture. Stateless UDP ingress, Redis-routed
  ownership, the worker model, the fault model and transcript continuity, the
  subscription and result data models, and the rejected alternatives. **Start here.**
- [`design.md`](./design.md): the implementation specifics. Redis keys, the typed
  worker protocol, the failure walkthroughs, the packet header format.
- [`wire.md`](./wire.md): the audio wire surface. The subscription REST endpoint, the
  transcript/translation push events, and the UDP frame format.

## Related

- [`../protocol.md`](../protocol.md): the runtime transport contract the audio service
  sits on.
- [`../../001-cloud-core/auth/oem-auth.md`](../../001-cloud-core/auth/oem-auth.md): a
  connecting user already holds a Mentra access token from the OEM auth flow; the
  audio path verifies it and reads `mentraUserId` from its claims.
