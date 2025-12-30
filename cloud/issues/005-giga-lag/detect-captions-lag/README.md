# Detect Captions Lag

Observability to detect when Soniox (speech-to-text provider) is causing transcription delays.

## Documents

- **detect-captions-lag-spec.md** - Problem definition, goals, constraints
- **detect-captions-lag-architecture.md** - Technical implementation

## Quick Context

**Current**: Users report 10s-2min lag between speaking and seeing captions. No visibility into whether it's Soniox, our pipeline, or network.

**Proposed**: Track transcript "age" (how old it is when received) to definitively identify if Soniox is processing behind real-time.

## Key Context

Soniox returns timestamps relative to stream start (`end_ms`). We know stream start time. Simple math: `Lag = Now - (StreamStart + end_ms)` tells us exactly how far behind the transcript is. If lag is 55 seconds, Soniox processed it 55s behind real-time.

## Status

- [x] Add latency metrics to StreamMetrics interface
- [x] Calculate transcript age in SonioxTranscriptionProvider
- [x] Add automated alerting for high latency (>5s)
- [x] Track audio backlog (bytes sent vs transcribed)
- [x] Aggregate metrics in TranscriptionManager
- [x] Add periodic health monitoring
- [ ] Set up Better Stack alerts
- [ ] Build latency dashboard
- [ ] Implement auto-fallback on sustained high latency