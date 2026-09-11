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
- [`fault-regression-matrix.md`](./fault-regression-matrix.md): live QA checklist of
  transcription faults, edge cases, expected behavior, and regression coverage.
- [`e2e-fault-harness.md`](./e2e-fault-harness.md): repeatable phone E2E harness for
  local and Porter fault injection runs, with logcat/screenshot artifacts.

## Related

- [`../protocol.md`](../protocol.md): the runtime transport contract the audio service
  sits on.
- [`../../007-runtime-auth-independence/README.md`](../../007-runtime-auth-independence/README.md):
  a connecting user presents a `cloud-runtime` token; the audio path verifies it
  and reads the configured user id plus `tenantId` from its claims.
