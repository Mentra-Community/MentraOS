# Webview Refactor

Build web interface for live captions with transcript history and settings control.

## Documents

- **webview-refactor-spec.md** - Problem, goals, API design
- **webview-refactor-architecture.md** - Implementation details (TODO)

## Quick Context

**Before**: Old `index.ts` had global state, messy logic, no webview
**After**: Clean manager-based architecture with webview, REST APIs, SSE streaming

## Key Changes

- Cleaned up `index.ts` (300 → 90 lines)
- All state moved to UserSession managers
- Full webview with live transcript updates
- Settings via SimpleStorage (not SDK settings)

## Status

- [x] SettingsManager with SimpleStorage
- [x] DisplayManager (renamed from TranscriptProcessorManager)
- [x] TranscriptsManager stores transcripts + SSE broadcasting
- [x] REST API: GET /api/transcripts
- [x] REST API: GET/POST /api/settings/\*
- [x] SSE: GET /api/transcripts/stream (in Express, bypasses proxy)
- [x] React webview UI (clean component structure)
- [x] Language picker modal (searchable dropdown with chips)
- [x] Auto-scroll behavior with FAB
- [x] Speaker color coding
- [x] Cleaned index.ts (removed global state)
- [x] Settings wired to DisplayManager

## Architecture Overview

```
Browser Webview
    ↓ SSE (Express route, bypasses proxy)
/api/transcripts/stream (Express)
    ↓ uses authUserId
TranscriptsManager (stores transcripts[])
    ↓ listens to transcription events
    ↓ broadcasts to SSE clients
    ↓
UserSession
    ├── TranscriptsManager (history + SSE)
    ├── SettingsManager (SimpleStorage)
    └── DisplayManager (glasses display)
```

**Managers:**

1. **TranscriptsManager** - Stores transcript history (finals + 1 interim), SSE broadcasting
2. **SettingsManager** - Uses SimpleStorage, updates DisplayManager on changes
3. **DisplayManager** - Formats and displays on glasses (debouncing, inactivity timer)

## Key APIs

**REST (Bun routes, proxied via Express):**

```
GET  /api/transcripts              # Load transcript history
GET  /api/settings                 # Get all settings
POST /api/settings/language        # Set primary language
POST /api/settings/language-hints  # Set language hints (array)
POST /api/settings/display-lines   # Set glasses display lines (2-5)
POST /api/settings/display-width   # Set glasses display width (pixels)
```

**SSE (Express route, direct):**

```
GET  /api/transcripts/stream       # Server-sent events for live updates
```

## Frontend Structure

```
src/webview/
├── App.tsx                    # Main orchestrator
├── components/
│   ├── Header.tsx            # Title, connection status, language button
│   ├── TranscriptList.tsx    # Scrollable list with auto-scroll
│   ├── TranscriptItem.tsx    # Individual transcript with speaker colors
│   └── LanguageModal.tsx     # Searchable dropdown + chips for hints
├── hooks/
│   ├── useTranscripts.ts     # SSE connection + state
│   └── useSettings.ts        # REST API calls
└── lib/
    ├── languages.ts          # Language definitions (~30 languages)
    └── colors.ts             # Speaker color utilities
```

## Key Design Decisions

1. **SSE in Express, not Bun** - Express handles long-lived streaming connections properly, proxy couldn't handle SSE
2. **SimpleStorage only** - No SDK settings sync, avoids dual state management
3. **DisplayManager naming** - Clearer than "TranscriptProcessorManager" for what displays on glasses
4. **Searchable language hints** - Dropdown with chips, not 30+ buttons
5. **Transcript history** - Only finals + 1 interim (no duplicates)

## Memory Target

<10MB per session, 100 transcripts max (circular buffer)
