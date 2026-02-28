# LiveKit Bridge Panic - Send on Closed Channel

Critical crash in livekit-bridge when session cleanup races with LiveKit SDK callbacks.

## Documents

- **livekit-bridge-panic-spec.md** - Root cause analysis, fix proposal

## Quick Context

**Current**: `OnDataPacket` callback sends to `audioFromLiveKit` channel, but channel gets closed during session cleanup while callback is still firing
**Proposed**: Check `session.ctx.Done()` before channel send to safely bail out

## Key Context

The livekit-bridge Go service panics with `send on closed channel` when a session is cleaned up (timeout, error, reconnect) while audio packets are still being delivered by the LiveKit SDK. This crashes the entire bridge, disconnecting ALL users - not just the one whose session was cleaned up.

## Status

- [x] Root cause identified (race between Close() and OnDataPacket callback)
- [ ] Fix OnDataPacket to check context before send
- [ ] Review other callbacks for similar races
- [ ] Test with forced timeout scenarios