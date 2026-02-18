# Documentation Overhaul Specification

**Date:** November 3, 2024  
**Status:** Draft  
**Owner:** Documentation Team

## Problem Statement

The current Core Concepts documentation structure is organized around SDK implementation details (AppServer → AppSession → Features) rather than developer intent. This creates friction for developers who want to accomplish specific tasks like "display text" or "capture photos" but must first understand the underlying architecture.

### Key Issues

1. **Non-intuitive hierarchy** - Features are buried under implementation details
   - Display functionality hidden under "AppSession → Display & UI"
   - Audio split across multiple locations
   - Developers think "I want to display something" not "I need AppSession.layouts"

2. **Feature discoverability** - Hard to find how to do specific tasks
   - A developer wants to play audio - where do they look?
   - Camera features scattered vs. organized by capability

3. **Inconsistent organization** - Some features top-level, others nested arbitrarily
   - Why is Audio top-level but Display buried?
   - Hardware & Capabilities exists but overlaps with other sections

## Proposed Solution

Reorganize Core Concepts to be **feature-first** instead of implementation-first.

### New Structure: Feature-Based Organization

```
Core Concepts
├── App Lifecycle (foundational - how apps start/run/stop)
├── AppServer (foundational - your server class)
├── AppSession (foundational - brief overview, links to features)
├── Display >
│   ├── Layouts (TextWall, DoubleTextWall, ReferenceCard)
│   └── Dashboard (persistent status display)
├── Microphone >
│   ├── Speech-to-Text (transcription)
│   └── Audio Chunks (raw audio processing)
├── Speakers >
│   ├── Text-to-Speech (generate speech)
│   └── Playing Audio Files (play MP3s, sound effects)
├── Camera >
│   ├── Photo Capture
│   └── RTMP Streaming
├── Webviews >
│   ├── React Webviews
│   └── Webview Authentication
├── Permissions (what data apps can access)
├── Simple Storage (persistent key-value storage)
├── LED Control (control LEDs on glasses)
└── Hardware & Capabilities >
    ├── Overview (detecting hardware)
    ├── Display Glasses (G1, Vuzix)
    ├── Camera Glasses (Mentra Live)
    └── Device Capabilities (checking what's available)
```

## Design Principles

### 1. Feature Discovery First

- Organize by developer intent: "I want to display / capture / play"
- Top-level items are capabilities developers care about
- No need to understand implementation to find features

### 2. Logical Grouping

- **Input**: Microphone (what user says/hears)
- **Output**: Display (what user sees), Speakers (what user hears)
- **Capture**: Camera (photos/video)
- **Interaction**: Webviews, LED
- **System**: Permissions, Storage, Hardware

### 3. Shallow Hierarchy

- Maximum 2 levels deep where possible
- Only nest when features are clearly related
- Standalone pages for simple topics (Permissions, Simple Storage, LED)

### 4. Consolidate Overlapping Content

- **ONE** Hardware & Capabilities section with everything about device differences
- Remove duplicate/scattered hardware documentation
- Clear separation: feature docs vs. hardware compatibility docs

### 5. Progressive Disclosure

- Foundational concepts first (Lifecycle, AppServer, AppSession)
- AppSession page becomes a brief "this is your interface to features" with links
- Feature pages are self-contained with examples

## Content Changes

### Pages to Create/Reorganize

| Current Location                  | New Location                                    | Changes Needed                                          |
| --------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| `app-session/display-and-ui.mdx`  | `display/layouts.mdx` + `display/dashboard.mdx` | Split into two focused pages                            |
| `app-session/events-and-data.mdx` | Extract audio parts to Microphone section       | Keep events overview, move audio-specific to Microphone |
| `app-session/device-control.mdx`  | Split into Camera, LED sections                 | Break apart the "everything" page                       |
| `audio/*`                         | Split to `microphone/*` and `speakers/*`        | Reorganize by input vs output                           |
| `hardware-capabilities/*`         | Consolidate, add device-capabilities.mdx        | Make THE authoritative hardware section                 |
| Additional Topics →               | Move to Core Concepts                           | Webviews, LED, Camera belong in Core                    |

### AppSession Page Changes

**Current:** 300+ lines covering what AppSession is, lifecycle, all features  
**New:** ~150 lines - brief overview showing:

- What AppSession is (your interface to glasses)
- How you get it (passed to onSession)
- What you can do with it (table of features with links)
- Quick example

Then link to feature-specific pages for details.

## Implementation Plan

### Phase 1: Restructure Navigation ✅ COMPLETE

1. ✅ Updated `docs.json` with new hierarchy
2. ✅ Created new folder structure (display/, microphone/, speakers/, camera/, webviews/, led/)
3. ✅ Moved existing pages to new locations (used `git mv` to preserve history)

### Phase 2: Split Large Pages ✅ COMPLETE

1. ✅ Split `display-and-ui.mdx` → `layouts.mdx` + `dashboard.mdx`
2. ✅ Split Audio → Microphone (speech-to-text, audio-chunks) + Speakers (text-to-speech, playing-audio-files)
3. ✅ Moved Camera from additional-topics to core-concepts/camera/
4. ✅ Moved Webviews from additional-topics to core-concepts/webviews/
5. ✅ Moved LED from additional-topics to core-concepts/led/
6. ✅ Consolidated Hardware & Capabilities with device-capabilities.mdx
7. ✅ Moved Mira Tool Calls to core-concepts
8. ✅ Removed empty additional-topics folder

### Phase 3: Update Content 🚧 IN PROGRESS

1. ⏳ Rewrite AppSession to be brief overview (TODO)
2. ✅ Ensured each feature page is self-contained
3. ✅ Added SDK-grounded examples to all pages
4. ⏳ Cross-link related features (TODO)

### Phase 4: Verify & Polish 📋 TODO

1. ⏳ Check all internal links
2. ⏳ Ensure consistent formatting
3. ⏳ Verify code examples are accurate
4. ⏳ Test navigation flow</parameter>
   </parameter>
5. Test navigation flow

## Success Criteria

- [x] Developer can find "how to display text" in <2 clicks (Display → Layouts)
- [x] Each feature has a dedicated, discoverable section
- [x] No feature is buried under implementation details
- [x] Hardware documentation is consolidated in ONE place (Hardware & Capabilities section)
- [x] Navigation hierarchy is <3 levels deep everywhere
- [ ] AppSession page is brief and links to features (still needs update)</parameter>

## Decisions Made

1. ✅ **Additional Topics** - RESOLVED: Folded everything into Core Concepts. Mira Tool Calls and Device Capabilities are now core concepts.

2. ✅ **Feature page detail level** - RESOLVED: Each page shows API, one good example, links to reference docs for full details.

3. ✅ **Events organization** - RESOLVED: Keep brief events overview in AppSession, specific events in feature sections (e.g., onTranscription in Microphone section)</parameter>

## Final Structure (As Implemented)

```
Core Concepts
├── App Lifecycle
├── AppServer
├── AppSession (brief overview - still needs shortening)
├── Display >
│   ├── Layouts ✅
│   └── Dashboard ✅
├── Microphone >
│   ├── Speech-to-Text ✅
│   └── Audio Chunks ✅
├── Speakers >
│   ├── Text-to-Speech ✅
│   └── Playing Audio Files ✅
├── Camera > ✅
│   ├── Overview
│   ├── Photo Capture
│   └── RTMP Streaming
├── Webviews > ✅
│   ├── React Webviews
│   └── Webview Authentication
├── Permissions ✅
├── Simple Storage ✅
├── LED Control > ✅
│   └── Overview
├── Hardware & Capabilities > ✅
│   ├── Overview
│   ├── Display Glasses
│   ├── Camera Glasses
│   └── Device Capabilities
└── Mira Tool Calls ✅
```

## References

- Current structure: `docs/app-devs/core-concepts/`
- Feedback source: Developer feedback session, Nov 3, 2024
- Related: Previous restructure PR (app-lifecycle, app-session split)
- Implementation: Nov 6, 2024

## Notes

- All content already written and accurate to SDK
- This is primarily a **reorganization** not a rewrite
- Goal: Make docs match developer mental model, not implementation model
- Used `git mv` to preserve file history during reorganization
- **Additional Topics section has been removed** - everything is now in Core Concepts</parameter>
