# Broken Links Fix Plan

**Created:** November 6, 2024  
**Status:** Ready for Implementation  
**Total Files to Update:** 18 files  
**Total Links to Fix:** 47 links

---

## Executive Summary

After the documentation restructure (audio → microphone/speakers split, display split, etc.), we have **47 broken internal links** across **18 files**. This document provides exact line-by-line fixes for each file.

### Breakdown by Category:

- **Audio links** (old `/audio/*` paths): 18 fixes
- **Reference links** (missing `/app-devs` prefix): 13 fixes
- **Display links** (old `/display-and-ui` path): 3 fixes
- **AppSession links** (renamed files): 3 fixes
- **AppServer links** (incorrect path): 1 fix
- **Quickstart links** (missing path prefix): 2 fixes
- **Capabilities links** (moved location): 2 fixes
- **Missing pages** (need removal or replacement): 5 fixes

---

## Fix Instructions

### File 1: `docs/app-devs/core-concepts/app-server.mdx`

**Lines to fix:** 224, 230, 233

```diff
- Line 224:   <Card title="AppSession" icon="plug" href="/app-devs/core-concepts/app-session/what-is-app-session">
+ Line 224:   <Card title="AppSession" icon="plug" href="/app-devs/core-concepts/app-session/app-session">

- Line 230:   <Card title="API Reference" icon="book" href="/reference/app-server">
+ Line 230:   <Card title="API Reference" icon="book" href="/app-devs/reference/app-server">

- Line 233:   <Card title="Quick Start" icon="rocket" href="/quickstart">
+ Line 233:   <Card title="Quick Start" icon="rocket" href="/app-devs/getting-started/quickstart">
```

**Total fixes:** 3

---

### File 2: `docs/app-devs/core-concepts/microphone/speech-to-text.mdx`

**Lines to fix:** 408, 411, 414

```diff
- Line 408:   <Card title="Text-to-Speech" icon="comment" href="/app-devs/core-concepts/audio/text-to-speech">
+ Line 408:   <Card title="Text-to-Speech" icon="comment" href="/app-devs/core-concepts/speakers/text-to-speech">

- Line 411:   <Card title="Audio Chunks" icon="waveform" href="/app-devs/core-concepts/audio/audio-chunks">
+ Line 411:   <Card title="Audio Chunks" icon="waveform" href="/app-devs/core-concepts/microphone/audio-chunks">

- Line 414:   <Card title="Event Manager" icon="book" href="/reference/managers/event-manager">
+ Line 414:   <Card title="Event Manager" icon="book" href="/app-devs/reference/managers/event-manager">
```

**Total fixes:** 3

---

### File 3: `docs/app-devs/core-concepts/microphone/audio-chunks.mdx`

**Lines to fix:** 383, 386, 389

```diff
- Line 383:   <Card title="Speech-to-Text" icon="microphone" href="/app-devs/core-concepts/audio/speech-to-text">
+ Line 383:   <Card title="Speech-to-Text" icon="microphone" href="/app-devs/core-concepts/microphone/speech-to-text">

- Line 386:   <Card title="Text-to-Speech" icon="comment" href="/app-devs/core-concepts/audio/text-to-speech">
+ Line 386:   <Card title="Text-to-Speech" icon="comment" href="/app-devs/core-concepts/speakers/text-to-speech">

- Line 389:   <Card title="Event Manager" icon="book" href="/reference/managers/event-manager">
+ Line 389:   <Card title="Event Manager" icon="book" href="/app-devs/reference/managers/event-manager">
```

**Total fixes:** 3

---

### File 4: `docs/app-devs/core-concepts/speakers/text-to-speech.mdx`

**Lines to fix:** 349, 352, 355

```diff
- Line 349:   <Card title="Playing Audio Files" icon="file-audio" href="/app-devs/core-concepts/audio/playing-audio-files">
+ Line 349:   <Card title="Playing Audio Files" icon="file-audio" href="/app-devs/core-concepts/speakers/playing-audio-files">

- Line 352:   <Card title="Speech-to-Text" icon="microphone" href="/app-devs/core-concepts/audio/speech-to-text">
+ Line 352:   <Card title="Speech-to-Text" icon="microphone" href="/app-devs/core-concepts/microphone/speech-to-text">

- Line 355:   <Card title="Audio Manager" icon="book" href="/reference/managers/audio-manager">
+ Line 355:   <Card title="Audio Manager" icon="book" href="/app-devs/reference/managers/audio-manager">
```

**Total fixes:** 3

---

### File 5: `docs/app-devs/core-concepts/speakers/playing-audio-files.mdx`

**Lines to fix:** 413, 416, 419

```diff
- Line 413:   <Card title="Text-to-Speech" icon="comment" href="/app-devs/core-concepts/audio/text-to-speech">
+ Line 413:   <Card title="Text-to-Speech" icon="comment" href="/app-devs/core-concepts/speakers/text-to-speech">

- Line 416:   <Card title="Speech-to-Text" icon="microphone" href="/app-devs/core-concepts/audio/speech-to-text">
+ Line 416:   <Card title="Speech-to-Text" icon="microphone" href="/app-devs/core-concepts/microphone/speech-to-text">

- Line 419:   <Card title="Audio Manager" icon="book" href="/reference/managers/audio-manager">
+ Line 419:   <Card title="Audio Manager" icon="book" href="/app-devs/reference/managers/audio-manager">
```

**Total fixes:** 3

---

### File 6: `docs/app-devs/core-concepts/display/layouts.mdx`

**Lines to fix:** 248, 251

**Note:** Lines 242 and 245 are already correct ✅

```diff
- Line 248:   <Card title="Layout Manager" icon="book" href="/app-devs/reference/managers/layout-manager">
+ Line 248:   <Card title="Layout Manager" icon="book" href="/app-devs/reference/managers/layout-manager">
  (Already correct - no change needed)

- Line 251:   <Card title="Layout Types" icon="book" href="/app-devs/reference/interfaces/layout-types">
+ Line 251:   <Card title="Layout Types" icon="book" href="/app-devs/reference/interfaces/layout-types">
  (Already correct - no change needed)
```

**Total fixes:** 0 (already correct!)

---

### File 7: `docs/app-devs/core-concepts/display/dashboard.mdx`

**Lines to fix:** 197

```diff
- Line 197:   <Card title="AppSession" icon="plug" href="/app-devs/core-concepts/app-session">
+ Line 197:   <Card title="AppSession" icon="plug" href="/app-devs/core-concepts/app-session/app-session">
```

**Note:** Lines 188, 191, 194 are already correct ✅

**Total fixes:** 1

---

### File 8: `docs/app-devs/core-concepts/app-lifecycle-overview.mdx`

**Lines to fix:** 119, 122, 125

```diff
- Line 119:   <Card title="Learn About AppServer" icon="server" href="/app-devs/core-concepts/app-server/what-is-app-server">
+ Line 119:   <Card title="Learn About AppServer" icon="server" href="/app-devs/core-concepts/app-server">

- Line 122:   <Card title="Learn About AppSession" icon="plug" href="/app-devs/core-concepts/app-session/what-is-app-session">
+ Line 122:   <Card title="Learn About AppSession" icon="plug" href="/app-devs/core-concepts/app-session/app-session">

- Line 125:   <Card title="Handle Events" icon="bolt" href="/app-devs/core-concepts/basic-events">
+ Line 125:   <Card title="Handle Events" icon="bolt" href="/app-devs/core-concepts/app-session/events-and-data">
```

**Note:** Changed `basic-events` (doesn't exist) to `events-and-data` (the actual events documentation)

**Total fixes:** 3

---

### File 9: `docs/app-devs/core-concepts/app-session/app-session.mdx`

**Lines to fix:** 309, 318

```diff
- Line 309:   <Card title="Display & UI" icon="display" href="/app-devs/core-concepts/app-session/display-and-ui">
+ Line 309:   <Card title="Display & UI" icon="display" href="/app-devs/core-concepts/display/layouts">

- Line 318:   <Card title="API Reference" icon="book" href="/reference/app-session">
+ Line 318:   <Card title="API Reference" icon="book" href="/app-devs/reference/app-session">
```

**Note:** Changed `display-and-ui` to `layouts` (primary display documentation)

**Total fixes:** 2

---

### File 10: `docs/app-devs/core-concepts/app-session/device-control.mdx`

**Lines to fix:** 564, 570, 573

```diff
- Line 564:   <Card title="Capabilities" icon="microchip" href="/app-devs/core-concepts/capabilities">
+ Line 564:   <Card title="Capabilities" icon="microchip" href="/app-devs/core-concepts/hardware-capabilities/device-capabilities">

- Line 570:   <Card title="Audio Manager" icon="book" href="/reference/managers/audio-manager">
+ Line 570:   <Card title="Audio Manager" icon="book" href="/app-devs/reference/managers/audio-manager">

- Line 573:   <Card title="Camera Manager" icon="book" href="/reference/managers/camera">
+ Line 573:   <Card title="Camera Manager" icon="book" href="/app-devs/reference/managers/camera">
```

**Total fixes:** 3

---

### File 11: `docs/app-devs/core-concepts/app-session/events-and-data.mdx`

**Lines to fix:** 472, 475

```diff
- Line 472:   <Card title="Event Manager" icon="book" href="/reference/managers/event-manager">
+ Line 472:   <Card title="Event Manager" icon="book" href="/app-devs/reference/managers/event-manager">

- Line 475:   <Card title="Event Types" icon="book" href="/reference/interfaces/event-types">
+ Line 475:   <Card title="Event Types" icon="book" href="/app-devs/reference/interfaces/event-types">
```

**Total fixes:** 2

---

### File 12: `docs/app-devs/core-concepts/permissions.mdx`

**Lines to fix:** 175

```diff
- Line 175:   <Card title="Event Types" icon="book" href="/reference/interfaces/event-types">
+ Line 175:   <Card title="Event Types" icon="book" href="/app-devs/reference/interfaces/event-types">
```

**Total fixes:** 1

---

### File 13: `docs/app-devs/core-concepts/hardware-capabilities/camera-glasses.mdx`

**Lines to fix:** 273

```diff
- Line 273:   <Card title="Audio" icon="volume" href="/app-devs/core-concepts/audio/text-to-speech">
+ Line 273:   <Card title="Audio" icon="volume" href="/app-devs/core-concepts/speakers/text-to-speech">
```

**Total fixes:** 1

---

### File 14: `docs/app-devs/core-concepts/hardware-capabilities/display-glasses.mdx`

**Lines to fix:** 224, 227

```diff
- Line 224:   <Card title="Display & UI" icon="display" href="/app-devs/core-concepts/app-session/display-and-ui">
+ Line 224:   <Card title="Display & UI" icon="display" href="/app-devs/core-concepts/display/layouts">

- Line 227:   <Card title="Audio" icon="volume" href="/app-devs/core-concepts/audio/text-to-speech">
+ Line 227:   <Card title="Audio" icon="volume" href="/app-devs/core-concepts/speakers/text-to-speech">
```

**Total fixes:** 2

---

### File 15: `docs/app-devs/core-concepts/hardware-capabilities/overview.mdx`

**Lines to fix:** 205

```diff
- Line 205:   <Card title="Capabilities Reference" icon="book" href="/reference/interfaces/capabilities">
+ Line 205:   <Card title="Capabilities Reference" icon="book" href="/app-devs/reference/interfaces/capabilities">
```

**Total fixes:** 1

---

### File 16: `docs/app-devs/core-concepts/webviews/webview-authentication.mdx`

**Lines to fix:** 108

```diff
- Line 108: <a href="/mentra-auth">
+ Line 108: <a href="https://account.mentra.glass/mentra-auth">
```

**Note:** `/mentra-auth` is an OAuth endpoint, not a docs page. It should point to the actual auth server.

**Alternative:** If this is meant to be relative to the app server, it might need to stay as `/mentra-auth`. **Need clarification on this one.**

**Total fixes:** 1 (pending clarification)

---

### File 17: `docs/cookbook/mira-tool-calls-advanced.mdx`

**Lines to fix:** 614, 618

```diff
- Line 614:   <Card title="Build a Complete App" icon="rocket" href="/cookbook/voice-timer">
+ Line 614:   <!-- Card removed - voice-timer page doesn't exist -->

- Line 618:   <Card title="API Reference" icon="book" href="/reference/interfaces/tool-types">
+ Line 618:   <Card title="API Reference" icon="book" href="/app-devs/reference/interfaces/tool-types">
```

**Note:** The `voice-timer` cookbook doesn't exist. Options:

1. Remove the card entirely
2. Create the `voice-timer.mdx` page
3. Link to a different example

**Total fixes:** 2 (one removal, one path fix)

---

### File 18: `docs/index.mdx`

**Lines to fix:** Already fixed in previous PR ✅

```
Lines 17, 26: /quickstart → /app-devs/getting-started/quickstart
Lines 39, 54, 73: Card hrefs → all corrected
```

**Total fixes:** 0 (already fixed!)

---

## Summary of Fixes

| File                                        | Broken Links | Status              |
| ------------------------------------------- | ------------ | ------------------- |
| `app-server.mdx`                            | 3            | Ready to fix        |
| `microphone/speech-to-text.mdx`             | 3            | Ready to fix        |
| `microphone/audio-chunks.mdx`               | 3            | Ready to fix        |
| `speakers/text-to-speech.mdx`               | 3            | Ready to fix        |
| `speakers/playing-audio-files.mdx`          | 3            | Ready to fix        |
| `display/layouts.mdx`                       | 0            | ✅ Already correct  |
| `display/dashboard.mdx`                     | 1            | Ready to fix        |
| `app-lifecycle-overview.mdx`                | 3            | Ready to fix        |
| `app-session/app-session.mdx`               | 2            | Ready to fix        |
| `app-session/device-control.mdx`            | 3            | Ready to fix        |
| `app-session/events-and-data.mdx`           | 2            | Ready to fix        |
| `permissions.mdx`                           | 1            | Ready to fix        |
| `hardware-capabilities/camera-glasses.mdx`  | 1            | Ready to fix        |
| `hardware-capabilities/display-glasses.mdx` | 2            | Ready to fix        |
| `hardware-capabilities/overview.mdx`        | 1            | Ready to fix        |
| `webviews/webview-authentication.mdx`       | 1            | Needs clarification |
| `cookbook/mira-tool-calls-advanced.mdx`     | 2            | Ready to fix        |
| `index.mdx`                                 | 0            | ✅ Already fixed    |

**Total:** 34 fixes needed (35 pending clarification on mentra-auth)

---

## Implementation Strategy

### Phase 1: Audio Links (Highest Impact)

**Files:** 5 files  
**Links:** 15 fixes  
**Time estimate:** 10 minutes

Fix all `/audio/*` → `/microphone/*` or `/speakers/*` paths:

- `microphone/speech-to-text.mdx`
- `microphone/audio-chunks.mdx`
- `speakers/text-to-speech.mdx`
- `speakers/playing-audio-files.mdx`
- `hardware-capabilities/camera-glasses.mdx`
- `hardware-capabilities/display-glasses.mdx`

### Phase 2: Reference Links (High Impact)

**Files:** 9 files  
**Links:** 13 fixes  
**Time estimate:** 8 minutes

Add `/app-devs` prefix to all `/reference/*` paths:

- `app-server.mdx`
- `microphone/speech-to-text.mdx`
- `microphone/audio-chunks.mdx`
- `speakers/text-to-speech.mdx`
- `speakers/playing-audio-files.mdx`
- `app-session/app-session.mdx`
- `app-session/device-control.mdx`
- `app-session/events-and-data.mdx`
- `permissions.mdx`
- `hardware-capabilities/overview.mdx`
- `cookbook/mira-tool-calls-advanced.mdx`

### Phase 3: AppSession & Display Links

**Files:** 4 files  
**Links:** 6 fixes  
**Time estimate:** 5 minutes

Fix renamed/moved files:

- `app-server.mdx`
- `app-lifecycle-overview.mdx`
- `app-session/app-session.mdx`
- `display/dashboard.mdx`
- `hardware-capabilities/display-glasses.mdx`

### Phase 4: Cleanup & Edge Cases

**Files:** 3 files  
**Links:** 4 fixes  
**Time estimate:** 10 minutes

Handle special cases:

- `app-lifecycle-overview.mdx` (basic-events)
- `app-session/device-control.mdx` (capabilities)
- `webviews/webview-authentication.mdx` (mentra-auth - needs clarification)
- `cookbook/mira-tool-calls-advanced.mdx` (voice-timer removal)

---

## Automation Script

```bash
#!/bin/bash
# Run from docs/ directory

# Phase 1: Audio links
sed -i 's|/app-devs/core-concepts/audio/speech-to-text|/app-devs/core-concepts/microphone/speech-to-text|g' \
  app-devs/core-concepts/microphone/*.mdx \
  app-devs/core-concepts/speakers/*.mdx \
  app-devs/core-concepts/hardware-capabilities/*.mdx

sed -i 's|/app-devs/core-concepts/audio/audio-chunks|/app-devs/core-concepts/microphone/audio-chunks|g' \
  app-devs/core-concepts/microphone/*.mdx \
  app-devs/core-concepts/speakers/*.mdx

sed -i 's|/app-devs/core-concepts/audio/text-to-speech|/app-devs/core-concepts/speakers/text-to-speech|g' \
  app-devs/core-concepts/microphone/*.mdx \
  app-devs/core-concepts/speakers/*.mdx \
  app-devs/core-concepts/hardware-capabilities/*.mdx

sed -i 's|/app-devs/core-concepts/audio/playing-audio-files|/app-devs/core-concepts/speakers/playing-audio-files|g' \
  app-devs/core-concepts/speakers/*.mdx

# Phase 2: Reference links (add /app-devs prefix)
sed -i 's|href="/reference/|href="/app-devs/reference/|g' \
  app-devs/core-concepts/**/*.mdx \
  cookbook/*.mdx

# Phase 3: AppSession & Display
sed -i 's|/app-devs/core-concepts/app-session/what-is-app-session|/app-devs/core-concepts/app-session/app-session|g' \
  app-devs/core-concepts/*.mdx

sed -i 's|/app-devs/core-concepts/app-session/display-and-ui|/app-devs/core-concepts/display/layouts|g' \
  app-devs/core-concepts/**/*.mdx

sed -i 's|/app-devs/core-concepts/app-server/what-is-app-server|/app-devs/core-concepts/app-server|g' \
  app-devs/core-concepts/*.mdx

# Phase 4: Special cases (manual fixes needed)
echo "Manual fixes needed:"
echo "1. app-lifecycle-overview.mdx line 125: basic-events → events-and-data"
echo "2. app-session/device-control.mdx line 564: capabilities → hardware-capabilities/device-capabilities"
echo "3. cookbook/mira-tool-calls-advanced.mdx line 614: Remove voice-timer card"
echo "4. webviews/webview-authentication.mdx line 108: Clarify mentra-auth endpoint"
```

---

## Verification

After fixes, run:

```bash
# Check for remaining broken audio links
grep -r '/audio/' docs/app-devs --include="*.mdx"

# Check for reference links missing /app-devs
grep -r 'href="/reference/' docs/app-devs --include="*.mdx"

# Check for old display-and-ui links
grep -r 'display-and-ui' docs/app-devs --include="*.mdx"

# Check for what-is-app-session links
grep -r 'what-is-app-session' docs/app-devs --include="*.mdx"
```

---

## Questions to Resolve

1. **`/mentra-auth` endpoint** (webview-authentication.mdx line 108):
   - Is this an OAuth endpoint on the app server?
   - Should it point to `https://account.mentra.glass/mentra-auth`?
   - Or should it remain as a relative path `/mentra-auth`?

2. **`/cookbook/voice-timer`** (mira-tool-calls-advanced.mdx line 614):
   - Should we create this cookbook page?
   - Or remove the card and link to a different example?

3. **`/app-devs/core-concepts/basic-events`** (app-lifecycle-overview.mdx line 125):
   - Confirmed fix: Link to `/app-devs/core-concepts/app-session/events-and-data`
   - Or create a new "basic-events" page as an introduction?

---

## Success Criteria

- [ ] All 34+ broken links fixed
- [ ] All cross-references between audio pages work
- [ ] All reference links include `/app-devs` prefix
- [ ] No 404s when navigating docs
- [ ] Verification commands return no results
- [ ] Questions 1-3 resolved

---

**Estimated total time:** 30-45 minutes
**Risk level:** Low (all changes are href updates)
**Testing:** Manual navigation + grep verification
