# Webview Refactor Spec

## Overview

Build webview UI for live captions app. Displays real-time transcript history to user in browser with language/display settings control.

**Status:** ✅ Complete and Working

## Problem (Solved)

1. ~~Captions work on glasses (`index.ts`) but user can't see transcript history~~ ✅
2. ~~No web interface to change language settings~~ ✅
3. ~~Transcripts not tracked - lost after displayed on glasses~~ ✅
4. ~~No way to review what was said during conversation~~ ✅
5. ~~Global state scattered across `index.ts` (300 lines)~~ ✅

## Goals

### Primary

1. Display transcript history (interim + final) in webview
2. Real-time transcript updates via SSE
3. REST API for settings (language, hints, display config)
4. SettingsManager using SimpleStorage for persistence

### Secondary

- Auto-scroll behavior (disable when user scrolls up)
- Speaker color coding (consistent per session)
- Mobile-first UI matching MentraOS style
- Empty state when no transcripts

### Success Metrics

| Metric                      | Target           |
| --------------------------- | ---------------- |
| Transcript update latency   | <100ms           |
| Settings change apply time  | <200ms           |
| Session transcript capacity | 100+ transcripts |
| Memory per session          | <10MB            |

## Non-Goals

- Transcript persistence across sessions (memory-only) ✅
- Export/download transcripts
- Multi-user collaboration
- Translation features
- Audio playback
- Settings modal for glasses display (removed - language modal only)

## Technical Constraints (Implemented)

- ✅ Cleaned `index.ts` (300 → 90 lines, removed global state)
- ✅ Built `UserSession` with 3 managers (Transcripts, Settings, Display)
- ✅ Memory-only transcript storage (session lifetime, max 100)
- ✅ Auth via Express → Bun header forwarding (`x-auth-user-id`)
- ✅ Settings persistence via SimpleStorage (not SDK settings)
- ✅ SSE in Express (bypasses proxy due to streaming requirements)

## API Design (Implemented)

### REST Endpoints (Bun routes, proxied via Express)

**Transcripts:**

```
GET /api/transcripts
Response: {
  transcripts: [
    {
      id: string              // UUID
      speaker: string         // "Speaker 1", "Speaker 2"
      text: string
      timestamp: string | null // "2:30 PM" or null
      isFinal: boolean
    }
  ]
}
```

**Settings:**

```
GET /api/settings
Response: {
  language: string              // "English", "Spanish", etc.
  languageHints: string[]       // ["es", "fr", "de"]
  displayLines: number          // 2-5
  displayWidth: number          // pixels (30, 45, 60)
}

POST /api/settings/language
Body: { language: string }
Response: { success: boolean }

POST /api/settings/language-hints
Body: { hints: string[] }        // Array of language codes
Response: { success: boolean }

POST /api/settings/display-lines
Body: { lines: number }          // 2-5
Response: { success: boolean }

POST /api/settings/display-width
Body: { width: number }          // pixels
Response: { success: boolean }
```

### SSE Stream (Express route, bypasses proxy)

```
GET /api/transcripts/stream
Content-Type: text/event-stream
Auth: Required via Express middleware (authUserId)

Events:
data: {"type":"connected"}
data: {"type":"interim","id":"abc123","speaker":"Speaker 1","text":"hello..."}
data: {"type":"final","id":"abc123","speaker":"Speaker 1","text":"hello world","timestamp":"2:30 PM"}
```

**Why SSE in Express?**

- Proxy can't handle long-lived streaming connections (ECONNRESET errors)
- Express handles SSE properly with Connection: keep-alive
- Auth middleware already available in Express

## Data Structures (Implemented)

### Transcript Entry

```typescript
interface TranscriptEntry {
  id: string // UUID (crypto.randomUUID)
  speaker: string // "Speaker 1", "Speaker 2", etc.
  text: string // Transcript text
  timestamp: string | null // "2:30 PM" or null for interim
  isFinal: boolean // true = final, false = interim
  receivedAt: number // Unix timestamp for ordering
}
```

**Key behaviors:**

- History contains only **final transcripts + 1 current interim**
- When final arrives, replaces last interim (no duplicates)
- Circular buffer with 100 max transcripts

### Settings Schema (SimpleStorage)

```typescript
interface CaptionSettings {
  language: string // "English", "Spanish", etc.
  languageHints: string[] // ["es", "fr", "de"]
  displayLines: number // 2-5 lines on glasses
  displayWidth: number // pixels (30, 45, 60)
}
```

**Storage location:** `appSession.simpleStorage` (NOT `appSession.settings`)

## Architecture (Implemented)

### Data Flow

```
Transcription Event (from MentraOS)
    ↓
index.ts handleTranscription() [cleaned up, 90 lines]
    ↓ parallel
    ├─→ DisplayManager.processAndDisplay()
    │   ↓ formats, debounces (400ms)
    │   ↓ shows on glasses via layouts.showTextWall()
    │
    └─→ TranscriptsManager.onTranscription()
        ↓ stores in memory (finals + 1 interim)
        ↓ broadcasts to SSE clients
        ↓ Browser updates UI
```

### Component Structure (Implemented)

```
src/app/session/
  ├── UserSession.ts          # Orchestrates 3 managers
  ├── TranscriptsManager.ts   # History + SSE broadcasting
  ├── SettingsManager.ts      # SimpleStorage wrapper
  └── DisplayManager.ts       # Glasses display (renamed from TranscriptProcessorManager)

src/api/
  ├── routes.ts               # Merges all route modules
  ├── transcripts.ts          # GET /api/transcripts
  ├── transcripts-stream.ts   # SSE endpoint (NOT USED - moved to Express)
  ├── settings.ts             # Settings CRUD
  └── auth-helpers.ts         # getAuthUserId, requireAuth

src/index.ts                  # Express SSE route added here (bypasses proxy)

src/webview/
  ├── App.tsx                 # Main orchestrator (22 lines)
  ├── components/
  │   ├── Header.tsx          # Title, connection, language button
  │   ├── TranscriptList.tsx  # Scrollable list + auto-scroll + FAB
  │   ├── TranscriptItem.tsx  # Transcript with speaker colors
  │   └── LanguageModal.tsx   # Searchable dropdown + chips
  ├── hooks/
  │   ├── useTranscripts.ts   # SSE + auto-reconnect
  │   └── useSettings.ts      # REST API calls
  └── lib/
      ├── languages.ts        # ~30 languages + search
      └── colors.ts           # Speaker color utilities
```

## Implementation Summary (Completed)

### ✅ Phase 1: Backend Foundation

- Created `SettingsManager` with SimpleStorage
- Created `DisplayManager` (glasses display logic)
- Created `TranscriptsManager` (history + SSE)
- Cleaned `index.ts` (removed global state)

### ✅ Phase 2: REST APIs

- Built `/api/transcripts` endpoint
- Built `/api/settings/*` endpoints (4 routes)
- Tested and working

### ✅ Phase 3: SSE Stream

- Built SSE in Express (not Bun - proxy issue)
- Events: connected, interim, final
- Proper client disconnect handling

### ✅ Phase 4: Frontend

- Clean component structure (Header, TranscriptList, TranscriptItem, LanguageModal)
- SSE connection with auto-reconnect
- Language picker with searchable dropdown + chips
- Auto-scroll with FAB (floating action button)

### ✅ Phase 5: Polish

- Speaker color coding (6 pastel colors)
- Empty state ("Waiting for conversation")
- Mobile-first responsive design
- Connection status indicator

## Questions (Resolved)

1. **Speaker normalization**: ✅ Currently hardcoded "Speaker 1" - Soniox provides speaker IDs
2. **Transcript limits**: ✅ Set to 100 max (circular buffer)

3. **SSE reconnection**: ✅ Load full history on initial connect, then stream updates

4. **Settings apply timing**: ✅ Settings only affect future transcripts (DisplayManager updated on change)

5. **Multiple webview connections**: ✅ Yes - SSE supports multiple clients per user

6. **SSE in Bun or Express?**: ✅ Express - proxy can't handle streaming (ECONNRESET)

7. **SDK settings vs SimpleStorage?**: ✅ SimpleStorage only - removed SDK settings sync

8. **Language hints UI?**: ✅ Searchable dropdown with chips (not 30+ buttons)

## Security (Implemented)

- ✅ All Bun routes require auth (via `x-auth-user-id` header from proxy)
- ✅ Express SSE route uses auth middleware (`req.authUserId`)
- ✅ Settings isolated per user (SimpleStorage per userId)
- ✅ No XSS risk (React escapes by default)
- ✅ No transcript leakage (UserSession per userId)

## Testing Strategy

**Manual testing (completed):**

- ✅ Webview loads and connects via SSE
- ✅ Transcripts appear in real-time (interim → final)
- ✅ Language modal opens with searchable dropdown
- ✅ Language hints appear as chips with × to remove
- ✅ Auto-scroll works, FAB appears when scrolled up
- ✅ Settings persist across sessions (SimpleStorage)
- ✅ Speaker colors display correctly
- ✅ DisplayManager shows text on glasses (verified in logs)

**Unit tests (future):**

- `TranscriptsManager`: interim/final replacement logic
- `SettingsManager`: SimpleStorage CRUD
- `DisplayManager`: debouncing, inactivity timer

**Integration tests (future):**

- REST API endpoints with auth
- SSE stream event delivery
- Settings changes propagate to DisplayManager</parameter>
