# Live Preview Sync for Settings Page

Mirror the actual glasses display in the webview settings preview.

## Documents

- **preview-sync-spec.md** - Problem analysis, design, and implementation plan

## Quick Context

**Current**: Settings page shows hardcoded static preview text. Display width conversion has a bug with numeric enum values.

**Proposed**: Stream display data via SSE to webview so preview mirrors what's shown on glasses in real-time.

## Key Insight

`DisplayManager.showOnGlasses()` already has the formatted text ready to send to glasses. We just need to also broadcast it via the existing SSE infrastructure to the webview.

## Status

- [x] Investigation complete
- [x] Bug identified in `convertLineWidth` (doesn't handle 0/1/2 enum values)
- [ ] Fix `convertLineWidth` to handle numeric enum
- [ ] Add `broadcastDisplayPreview()` to TranscriptsManager
- [ ] Update DisplayManager to broadcast after showOnGlasses
- [ ] Handle `display_preview` SSE message in webview
- [ ] Update Settings.tsx preview to show live data