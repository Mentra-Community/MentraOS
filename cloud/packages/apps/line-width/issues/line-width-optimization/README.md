# Line Width Optimization

Maximize text per line on glasses display without causing line overflow.

## Documents

- **line-width-spec.md** - Problem analysis and constraints
- **line-width-architecture.md** - Technical design and implementation plan

## Quick Context

**Current**: Both cloud (`TranscriptProcessor.ts`) and mobile (`G1Text.kt`) wrap text independently. This double-wrapping can cause >5 lines, hiding the most recent text.

**New Approach**: Disable mobile wrapping, make cloud the single source of truth for all text layout.

## Key Findings

Using actual G1 font glyph data from `G1FontLoaderKt`:

| Metric                          | Value                  |
| ------------------------------- | ---------------------- |
| Display width                   | 488px                  |
| Effective width (after margins) | 428px                  |
| Current "Wide" (44 chars)       | 528px ❌ exceeds limit |
| Current "Medium" (38 chars)     | 456px ❌ exceeds limit |
| Current "Narrow" (30 chars)     | 360px ✅ fits          |
| Max 'a' chars that fit          | 35 chars               |

**Problem**: Both "Medium" and "Wide" settings exceed mobile's effective width, triggering re-wrap.

## New Approach

1. **Mobile disables wrapping** - Bypass `splitIntoLines()` in `G1Text.kt`, passthrough cloud text directly
2. **Cloud becomes single source of truth** - All wrapping decisions happen server-side
3. **Test & calibrate** - With mobile passthrough, test on real glasses to find true hardware limits
4. **Finalize cloud settings** - Set `VisualWidthSettings` based on empirical hardware testing

## Benefits

- Single wrapping system (no double-wrap causing 6+ lines)
- Easier debugging (issues always trace to cloud)
- Faster iteration (no mobile app updates needed)
- Preview accuracy (cloud webview matches glasses exactly)

## Status

- [x] Analyze pixel-based wrapping in `G1Text.kt`
- [x] Map cloud visual width units to mobile pixel calculations
- [x] Identify current settings exceed mobile limits
- [ ] **Mobile: Disable `splitIntoLines()` wrapping**
- [ ] Test with real glasses to find true hardware limits
- [ ] Determine if mobile margin logic (5-space indent) should move to cloud
- [ ] Update cloud `VisualWidthSettings` with calibrated values
- [ ] Test with mixed Latin/CJK content
- [ ] Test with speaker labels `[N]:` prefix overhead

## Open Questions

1. What's the actual usable pixel width on glasses hardware?
2. Should margin/indent logic stay in mobile or move to cloud?
3. How does mobile handle CJK characters? (hardcoded glyphs are Latin-only)
