# Line Width Debug Tool

Debug app to discover and validate optimal text wrapping logic for G1 glasses display.

## Documents

- **line-width-spec.md** - Problem, goals, test methodology
- **line-width-architecture.md** - Technical design and implementation

## Quick Context

**Problem**: We need to find the true pixel limits of the G1 glasses display and validate our width calculations before implementing wrapping logic in the cloud.

**Approach**: Build a debug tool that sends raw text to glasses (mobile wrapping disabled) and lets us compare what we sent vs what the glasses display. If they match, our calculations are correct.

## Key Hypothesis

Our pixel calculations from `G1FontLoaderKt` glyph data:
- Narrow chars (`l`, `i`) = ~4px each → more chars fit per line
- Average chars (`a`, `e`) = ~12px each
- Wide chars (`m`, `w`) = ~16px each

**Test**: Can we fit more narrow chars than wide chars in one line at the same pixel width?

## Test Flow

```
Webview UI → SDK showTextWall() → Mobile (passthrough) → Glasses
     ↓
Preview (shows exactly what we sent + calculated pixels)
     ↓
User compares: Preview vs Glasses
     ↓
Match → Our pixel logic is correct
Mismatch → Our pixel logic needs adjustment
```

## Status

- [ ] Strip captions-specific code from duplicated app
- [ ] Implement pixel width calculator (port G1 glyph data)
- [ ] Build test string generator (by char type, target pixels)
- [ ] Create webview UI with preview and controls
- [ ] Add results logging for test tracking
- [ ] Run calibration tests to validate glyph widths
- [ ] Find true max pixel width before firmware wrap
- [ ] Document findings for cloud implementation