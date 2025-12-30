# Transcription Dual-Stream Resource Waste

Multiple Soniox WebSocket streams created for the same base language when apps subscribe with different query parameters.

## Documents

- **dual-stream-spec.md** - Problem analysis and proposed fix

## Quick Context

**Current**: `transcription:en-US` and `transcription:en-US?hints=es,fr` create separate Soniox WebSocket connections, wasting resources.

**Proposed**: Normalize subscription keys at stream creation to deduplicate by base language.

## Key Insight

The subscription routing (`getSubscribedApps`) already ignores query params when matching apps to data. But `TranscriptionManager.streams` Map uses the full subscription string (including query params) as the key, creating duplicate streams.

## Status

- [x] Bug confirmed via code analysis
- [ ] Implement stream key normalization
- [ ] Test with multiple apps subscribing to same language