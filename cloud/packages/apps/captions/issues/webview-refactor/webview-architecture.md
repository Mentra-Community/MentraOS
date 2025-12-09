# Webview Architecture

Clean component organization for the live captions React frontend.

## Directory Structure

```
src/webview/
├── App.tsx                           # Main app shell
├── index.html                        # HTML entry point
├── frontend.tsx                      # React root
├── index.css                         # Global styles
├── globals.css                       # Tailwind base
│
├── components/                       # UI Components
│   ├── TranscriptList.tsx           # Scrollable transcript container
│   ├── TranscriptItem.tsx           # Individual transcript entry
│   ├── LanguageModal.tsx            # Language picker modal
│   ├── Header.tsx                   # Top header bar
│   └── ui/                          # Shadcn components
│       ├── button.tsx
│       ├── dialog.tsx
│       └── select.tsx
│
├── hooks/                           # Custom hooks
│   ├── useTranscripts.ts           # SSE connection + transcript state
│   ├── useSettings.ts              # Settings CRUD operations
│   └── useAutoScroll.ts            # Auto-scroll behavior
│
└── lib/                             # Utilities
    ├── languages.ts                # Language definitions
    └── colors.ts                   # Speaker color utilities
```

## Component Hierarchy

```
App
├── Header
│   ├── BackButton
│   ├── Title
│   ├── ConnectionStatus
│   ├── LanguageModal (Dialog)
│   └── SettingsButton
│
└── TranscriptList
    ├── EmptyState (when no transcripts)
    ├── TranscriptItem[] (for each transcript)
    └── ScrollToBottomButton (FAB when scrolled up)
```

## Data Flow

```
useTranscripts hook
    ↓ SSE connection
    ↓ receives events
    ↓ updates transcripts[] state
    ↓
TranscriptList component
    ↓ maps over transcripts
    ↓
TranscriptItem components
    ↓ display with speaker colors

useSettings hook
    ↓ REST API calls
    ↓ updates settings state
    ↓
LanguageModal
    ↓ displays current settings
    ↓ calls updateLanguage/updateHints
    ↓
Settings persisted via SettingsManager
```

## Component Details

### App.tsx (Main Shell)

**Responsibilities:**

- Layout structure (header + content)
- Orchestrate hooks (useTranscripts, useSettings)
- Pass data to child components

**State:** None (delegates to hooks)

```typescript
export function App() {
  const {transcripts, connected} = useTranscripts()
  const {settings, updateLanguage, updateLanguageHints} = useSettings()

  return (
    <div className="flex flex-col h-screen">
      <Header
        connected={connected}
        settings={settings}
        onUpdateLanguage={updateLanguage}
        onUpdateHints={updateLanguageHints}
      />
      <TranscriptList transcripts={transcripts} />
    </div>
  )
}
```

### Header.tsx

**Responsibilities:**

- Back button
- Title
- Connection status indicator
- Language button (opens modal)
- Settings button

**Props:**

```typescript
interface HeaderProps {
  connected: boolean
  settings: CaptionSettings | null
  onUpdateLanguage: (lang: string) => Promise<boolean>
  onUpdateHints: (hints: string[]) => Promise<boolean>
}
```

### TranscriptList.tsx

**Responsibilities:**

- Scrollable container
- Auto-scroll behavior
- Empty state
- Map transcripts to items
- Scroll-to-bottom FAB

**Props:**

```typescript
interface TranscriptListProps {
  transcripts: Transcript[]
}
```

**Internal state:**

- `autoScroll: boolean`
- `scrollContainerRef: RefObject<HTMLDivElement>`

### TranscriptItem.tsx

**Responsibilities:**

- Display single transcript
- Speaker name + color
- Timestamp or "Now"
- Text (italic for interim)

**Props:**

```typescript
interface TranscriptItemProps {
  transcript: Transcript
  color: string // Speaker color class
}
```

### LanguageModal.tsx

**Responsibilities:**

- Dialog wrapper
- Primary language selector (dropdown)
- Language hints (pill buttons)
- Save/Cancel actions

**Props:**

```typescript
interface LanguageModalProps {
  currentLanguage: string
  currentHints: string[]
  onSave: (language: string, hints: string[]) => Promise<void>
}
```

**Internal state:**

- `tempLanguage: string` (staging before save)
- `tempHints: string[]` (staging before save)

## Hooks

### useTranscripts()

**Purpose:** Manage SSE connection and transcript state

**Returns:**

```typescript
{
  transcripts: Transcript[]
  connected: boolean
  error: string | null
}
```

**Logic:**

1. Load initial history via GET /api/transcripts
2. Connect to SSE /api/transcripts/stream
3. Handle interim/final events
4. Auto-reconnect on disconnect

### useSettings()

**Purpose:** Manage settings CRUD operations

**Returns:**

```typescript
{
  settings: CaptionSettings | null
  loading: boolean
  error: string | null
  updateLanguage: (lang: string) => Promise<boolean>
  updateLanguageHints: (hints: string[]) => Promise<boolean>
  updateDisplayLines: (lines: number) => Promise<boolean>
  updateDisplayWidth: (width: number) => Promise<boolean>
  refetch: () => Promise<void>
}
```

### useAutoScroll()

**Purpose:** Extract auto-scroll logic from TranscriptList

**Returns:**

```typescript
{
  scrollContainerRef: RefObject<HTMLDivElement>
  autoScroll: boolean
  handleScroll: () => void
  scrollToBottom: () => void
}
```

**Logic:**

1. Track scroll position
2. Disable auto-scroll when user scrolls up
3. Re-enable when scrolled to bottom
4. Auto-scroll on new transcripts

## Utilities

### lib/languages.ts

**Purpose:** Language definitions and lookups

```typescript
export const AVAILABLE_LANGUAGES = [
  {code: "en", name: "English"},
  {code: "es", name: "Spanish"},
  {code: "fr", name: "French"},
  {code: "de", name: "German"},
  {code: "zh", name: "Chinese"},
  {code: "ja", name: "Japanese"},
  // ... ~100 languages
]

export function getLanguageName(code: string): string {
  return AVAILABLE_LANGUAGES.find((l) => l.code === code)?.name || code
}

export function searchLanguages(query: string): Language[] {
  return AVAILABLE_LANGUAGES.filter((l) => l.name.toLowerCase().includes(query.toLowerCase()))
}
```

### lib/colors.ts

**Purpose:** Speaker color utilities

```typescript
const SPEAKER_COLORS = [
  "bg-blue-50 border-blue-200",
  "bg-purple-50 border-purple-200",
  "bg-green-50 border-green-200",
  "bg-amber-50 border-amber-200",
  "bg-pink-50 border-pink-200",
  "bg-cyan-50 border-cyan-200",
]

export function getSpeakerColor(speaker: string): string {
  const speakerNum = parseInt(speaker.replace("Speaker ", "")) - 1
  return SPEAKER_COLORS[speakerNum % SPEAKER_COLORS.length]
}
```

## Language Modal Implementation

### Primary Language

- Dropdown (shadcn Select component)
- Shows all available languages
- Single selection
- Updates immediately on change

### Language Hints

- Pill buttons (toggleable)
- Excludes primary language
- Multiple selection
- Green highlight when selected
- Searchable (future enhancement)

### Save/Cancel Flow

```
1. User opens modal → loads current settings
2. User changes language → updates tempLanguage (local state)
3. User toggles hints → updates tempHints (local state)
4. User clicks Save → calls onSave(tempLanguage, tempHints)
5. onSave calls API → updateLanguage + updateHints
6. Success → modal closes, settings updated
7. Cancel → modal closes, no changes
```

## Styling Guidelines

### Colors

- Background: `bg-white`
- Text primary: `text-gray-900`
- Text secondary: `text-gray-600`
- Borders: `border-gray-200`
- Connection status: `bg-green-500` / `bg-red-500`
- Speaker backgrounds: Soft pastels (blue, purple, green, amber, pink, cyan)

### Typography

- Title: `text-lg font-medium`
- Speaker name: `text-sm font-medium`
- Transcript text: `text-base leading-relaxed`
- Timestamp: `text-xs text-gray-500`
- "Now" indicator: `text-xs text-gray-400 italic`

### Spacing

- Header padding: `px-4 py-3`
- Content padding: `px-4 py-6`
- Transcript spacing: `space-y-6`
- Button gaps: `gap-2`

### Mobile-First

- Full-height layout: `h-screen`
- Scrollable content: `flex-1 overflow-y-auto`
- Fixed header: Always visible at top
- FAB position: `fixed bottom-6 right-6`

## Testing Strategy

### Component Tests

- TranscriptItem renders correctly (final vs interim)
- TranscriptList handles empty state
- LanguageModal saves/cancels properly
- Header shows connection status

### Hook Tests

- useTranscripts connects to SSE
- useTranscripts handles reconnection
- useSettings CRUD operations work
- useAutoScroll detects scroll position

### Integration Tests

- Full flow: Load history → Connect SSE → Receive updates
- Language change updates transcription
- Auto-scroll works with new transcripts

## Performance Considerations

### Optimization

- Transcript list: Use `key={transcript.id}` for efficient re-renders
- SSE: Single connection per user
- Settings: Debounce rapid changes
- Scroll: RequestAnimationFrame for smooth scrolling

### Memory

- Transcript limit: 100 max (circular buffer server-side)
- SSE reconnection: Exponential backoff
- Event listeners: Clean up on unmount

## Future Enhancements

### Phase 1 (Current)

- ✅ Live transcript display
- ✅ Auto-scroll
- ✅ Language modal
- ✅ Connection status

### Phase 2 (Next)

- [ ] Search/filter transcripts
- [ ] Export transcript history
- [ ] Speaker name editing
- [ ] Transcript history pagination

### Phase 3 (Advanced)

- [ ] Offline support (cache transcripts)
- [ ] Push notifications for new transcripts
- [ ] Multi-device sync
- [ ] Translation overlay
