# SimpleStorage Limits & Rate Protection

Enforce storage limits and rate protection for SimpleStorage to prevent abuse and MongoDB overload.

## Documents

- **simple-storage-limits-spec.md** - Problem, goals, constraints
- **simple-storage-limits-architecture.md** - Technical design & implementation

## Quick Context

**Current**: No limits on value size or total storage, immediate HTTP per write → MongoDB abuse risk  
**Proposed**: 100KB/value, 1MB/user total, 3s/10s debounce + flush-on-disconnect

## Key Context

SimpleStorage is MongoDB-backed key/value storage where **App server RAM is source of truth** and MongoDB is crash recovery backup. Without limits, developers could serialize images/videos. Aggressive debounce batching (3s idle / 10s max) is perfect since users read from RAM instantly and MongoDB just needs eventual persistence.

## Status

- [ ] Spec finalized
- [ ] Architecture designed
- [ ] SDK validation implemented
- [ ] SDK batching implemented
- [ ] Cloud validation implemented
- [ ] Cloud rate limiting implemented
- [ ] SDK docs updated
- [ ] Migration tested
- [ ] Deployed to staging
- [ ] Deployed to production

## Key Metrics

| Metric              | Current          | Target            |
| ------------------- | ---------------- | ----------------- |
| Max value size      | Unlimited        | 100KB             |
| Max storage/user    | Unlimited        | 1MB               |
| SDK debounce        | None (immediate) | 3s idle / 10s max |
| Flush on disconnect | No               | Yes               |
