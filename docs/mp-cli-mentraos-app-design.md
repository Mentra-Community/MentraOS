# MentraOS MP-CLI App Design

## Purpose

Local MentraOS app that connects to mp-cli HTTP bridge and displays personal productivity data on Even Realities G1 glasses.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      G1 Smart Glasses                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Display  │  │   Mic    │  │  Button  │  │   IMU    │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
└───────┼─────────────┼─────────────┼─────────────┼──────────┘
        │             │             │             │
        └─────────────┴─────────────┴─────────────┘
                      BLE
        ┌─────────────┴─────────────────────────┐
        │                                        │
┌───────▼────────────────────────────────────────▼───────────┐
│              MentraOS Mobile App (Phone)                    │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              MP-CLI Mini App (WebView)               │  │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐    │  │
│  │  │ Dashboard  │  │   Brief    │  │  Messages  │    │  │
│  │  └────────────┘  └────────────┘  └────────────┘    │  │
│  └──────────────────────┬───────────────────────────────┘  │
│                         │                                   │
│  ┌──────────────────────▼───────────────────────────────┐  │
│  │              MiniComms Bridge                        │  │
│  │  • executeMpCommand()                                │  │
│  │  • subscribeToEvents()                               │  │
│  │  • formatForDisplay()                                │  │
│  └──────────────────────┬───────────────────────────────┘  │
│                         │                                   │
│  ┌──────────────────────▼───────────────────────────────┐  │
│  │           Native Modules (iOS/Android)               │  │
│  │  • HTTP Client                                       │  │
│  │  • WebSocket Client                                  │  │
│  │  • Voice Command Parser                              │  │
│  │  • Display Formatter                                 │  │
│  └──────────────────────┬───────────────────────────────┘  │
└─────────────────────────┼───────────────────────────────────┘
                          │ HTTP/WebSocket
                          │
┌─────────────────────────▼───────────────────────────────────┐
│              MP-CLI HTTP Bridge (Mac/Local)                 │
│  • REST API                                                 │
│  • WebSocket Events                                         │
│  • Command Execution                                        │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                    mp-cli (Python)                          │
│  • Task Management                                          │
│  • Stakeholder Tracking                                     │
│  • Message Integration                                      │
│  • Calendar Integration                                     │
└─────────────────────────────────────────────────────────────┘
```

## User Experience Flow

### 1. App Launch
```
User opens MentraOS app
  → Checks if G1 is connected
  → Checks if HTTP bridge is reachable
  → Shows connection status
  → Loads dashboard
```

### 2. Voice Command
```
User says "What's next?" to G1
  → G1 captures audio
  → Sends to phone via BLE
  → Phone transcribes to text
  → MentraOS app receives "what's next"
  → Parses to command: "next"
  → Calls HTTP bridge: POST /execute {command: "next"}
  → Receives response
  → Formats for G1 display
  → Sends to G1 via BLE
  → G1 displays formatted text
```

### 3. Dashboard View
```
User opens MP-CLI app in MentraOS
  → Loads dashboard (batch request)
  → Shows:
    - Next 3 tasks
    - Ball-in-court count
    - Today's calendar
    - Unread messages count
  → Updates every 30 seconds
```

### 4. Stakeholder Brief
```
User says "Brief for Alice"
  → Parses to: "sh brief alice"
  → Calls HTTP bridge
  → Receives Alice's info
  → Formats as:
    ┌─────────────────┐
    │ Alice Johnson   │
    │ Last: 2 days ago│
    │ Ball: Them      │
    │ Next: Follow up │
    └─────────────────┘
  → Displays on G1
```

## UI Components

### 1. Dashboard View (WebView)

```typescript
interface DashboardData {
  tasks: Task[]
  stakeholders: StakeholderSummary
  calendar: CalendarEvent[]
  messages: MessageSummary
  lastUpdated: string
}

interface Task {
  title: string
  project: string
  completion: number
  ballInCourt: 'me' | 'them'
}

interface StakeholderSummary {
  total: number
  ballInCourtMe: number
  ballInCourtThem: number
  needFollowUp: number
}

interface MessageSummary {
  unread: number
  recent: Message[]
}
```

**Layout:**
```
┌─────────────────────────────────┐
│         MP-CLI Dashboard        │
├─────────────────────────────────┤
│ Next Actions (3)                │
│ • Follow up with Alice (98%)    │
│ • Review proposal (95%)         │
│ • Schedule meeting (90%)        │
├─────────────────────────────────┤
│ Ball in Court                   │
│ Me: 5  │  Them: 12              │
├─────────────────────────────────┤
│ Today's Calendar                │
│ 3:00 PM - Meeting with Bob      │
│ 5:00 PM - Call with Carol       │
├─────────────────────────────────┤
│ Messages                        │
│ 3 unread from Alice, Bob, Carol │
└─────────────────────────────────┘
```

### 2. Stakeholder Brief View

```typescript
interface StakeholderBrief {
  name: string
  lastContact: string
  ballInCourt: 'me' | 'them'
  recentMessages: Message[]
  upcomingEvents: CalendarEvent[]
  openTasks: Task[]
  notes: string
}
```

**Layout:**
```
┌─────────────────────────────────┐
│      Alice Johnson Brief        │
├─────────────────────────────────┤
│ Last Contact: 2 days ago        │
│ Ball in Court: Them             │
├─────────────────────────────────┤
│ Recent Messages                 │
│ • "Are we still on for..."      │
│ • "Thanks for the update"       │
├─────────────────────────────────┤
│ Upcoming                        │
│ • Meeting tomorrow 3pm          │
├─────────────────────────────────┤
│ Open Tasks                      │
│ • Follow up on proposal (98%)   │
└─────────────────────────────────┘
```

### 3. Message View

```typescript
interface MessageView {
  stakeholder: string
  messages: Message[]
  canReply: boolean
}

interface Message {
  from: string
  text: string
  timestamp: string
  isFromMe: boolean
}
```

**Layout:**
```
┌─────────────────────────────────┐
│      Messages: Alice            │
├─────────────────────────────────┤
│ Alice: Are we still on for      │
│        tomorrow?                │
│        2 hours ago              │
├─────────────────────────────────┤
│ Me:    Yes, 3pm works great     │
│        1 hour ago               │
├─────────────────────────────────┤
│ Alice: Perfect, see you then    │
│        30 min ago               │
└─────────────────────────────────┘
```

## G1 Display Formatting

### Display Constraints (HARDWARE VALIDATED)

**Testing Date:** 2026-02-17  
**Device:** Even Realities G1

- **Maximum visible lines:** 5 lines (confirmed via hardware testing)
- **Characters per line:** ~40-50 characters (varies by character width)
- **Line wrapping:** Automatic at word boundaries
- **Overflow:** Text beyond 5 lines is cut off (not scrollable)
- **Symbols:** ✅ `→`, `•`, `📧` render correctly
- **Formatting:** Plain text only (no bold, colors, etc.)

### Formatting Rules

1. **Truncate long text**
   - Max 5 lines (hardware limit)
   - Add "..." for truncated text
   - Prioritize most important info at top

2. **Use symbols**
   - ✓ = Complete
   - • = Bullet point
   - → = Action required
   - ⏰ = Time-sensitive
   - 📧 = Message
   - 📅 = Calendar

3. **Prioritize info**
   - Most important at top
   - Use bold/highlight for key items (if supported)
   - Collapse less important details

### Example Formats (VALIDATED ON HARDWARE)

**Next Actions (5 lines):**
```
→ NEXT (3)
• Alice (98%)
• Proposal (95%)
• Meeting (90%)
Ball: Me 5 | Them 12
```

**Stakeholder Brief (5 lines):**
```
ALICE JOHNSON
Last: 2d | Ball: Them
📧 "Are we still on..."
📅 Tomorrow 3pm
→ Follow up proposal
```

**Messages (5 lines):**
```
ALICE (2h ago)
Are we still on for
tomorrow?

ME (1h ago)
Yes, 3pm works
```

## Voice Command Parsing

### Command Grammar

```
<command> := <action> [<target>] [<filter>]

<action> := "what's next" | "show" | "brief" | "messages" | "calendar"
<target> := "stakeholders" | "tasks" | <person_name>
<filter> := "today" | "this week" | "unread"
```

### Examples

| Voice Input | Parsed Command | API Call |
|------------|----------------|----------|
| "What's next?" | `{action: "next"}` | `POST /execute {command: "next"}` |
| "Show stakeholders" | `{action: "show", target: "stakeholders"}` | `POST /execute {command: "sh", args: ["list"]}` |
| "Brief for Alice" | `{action: "brief", target: "Alice"}` | `POST /execute {command: "sh", args: ["brief", "alice"]}` |
| "Messages from Alice" | `{action: "messages", target: "Alice"}` | `POST /execute {command: "sh", args: ["m", "c", "alice"]}` |
| "Calendar today" | `{action: "calendar", filter: "today"}` | `POST /execute {command: "calendar", args: ["today"]}` |

### Fuzzy Matching

- **Name matching:** "brief for alice" → finds "Alice Johnson"
- **Command aliases:** "what's up" → "what's next"
- **Typo tolerance:** "breif" → "brief"

## Native Bridge API

### TypeScript Interface

```typescript
interface MpCliBridge {
  // Execute single command
  executeCommand(command: string, args?: string[]): Promise<CommandResult>
  
  // Execute batch commands
  executeBatch(commands: Command[]): Promise<BatchResult>
  
  // Subscribe to events
  subscribeToEvents(callback: (event: MpEvent) => void): Subscription
  
  // Parse voice command
  parseVoiceCommand(text: string): Promise<ParsedCommand>
  
  // Format for G1 display
  formatForDisplay(data: any, type: DisplayType): string
  
  // Check connection
  checkConnection(): Promise<ConnectionStatus>
}

interface CommandResult {
  success: boolean
  data?: any
  error?: Error
  executionTimeMs: number
}

interface MpEvent {
  type: 'new_message' | 'calendar_reminder' | 'task_update'
  data: any
  timestamp: string
}

interface ParsedCommand {
  command: string
  args: string[]
  confidence: number
}

enum DisplayType {
  DASHBOARD = 'dashboard',
  BRIEF = 'brief',
  MESSAGES = 'messages',
  CALENDAR = 'calendar'
}

interface ConnectionStatus {
  bridgeReachable: boolean
  glassesConnected: boolean
  lastPing: string
}
```

### Usage Example

```typescript
import { mpCliBridge } from '@/services/MpCliBridge'

// Execute command
const result = await mpCliBridge.executeCommand('next')
if (result.success) {
  const formatted = mpCliBridge.formatForDisplay(result.data, DisplayType.DASHBOARD)
  sendToGlasses(formatted)
}

// Subscribe to events
const subscription = mpCliBridge.subscribeToEvents((event) => {
  if (event.type === 'new_message') {
    showNotification(event.data)
  }
})

// Parse voice
const parsed = await mpCliBridge.parseVoiceCommand("what's next")
const result = await mpCliBridge.executeCommand(parsed.command, parsed.args)
```

## State Management

### App State

```typescript
interface MpCliAppState {
  connection: {
    bridgeUrl: string
    bridgeReachable: boolean
    glassesConnected: boolean
    lastSync: string
  }
  
  dashboard: {
    data: DashboardData | null
    loading: boolean
    error: Error | null
    lastUpdated: string
  }
  
  currentView: {
    type: 'dashboard' | 'brief' | 'messages' | 'calendar'
    data: any
  }
  
  settings: {
    autoRefresh: boolean
    refreshInterval: number
    voiceEnabled: boolean
    notificationsEnabled: boolean
  }
}
```

### State Updates

```typescript
// On app launch
dispatch({ type: 'CHECK_CONNECTION' })
dispatch({ type: 'LOAD_DASHBOARD' })

// On voice command
dispatch({ type: 'PARSE_VOICE', payload: text })
dispatch({ type: 'EXECUTE_COMMAND', payload: command })
dispatch({ type: 'UPDATE_VIEW', payload: result })

// On event
dispatch({ type: 'NEW_EVENT', payload: event })
dispatch({ type: 'SHOW_NOTIFICATION', payload: notification })
```

## Settings & Configuration

### User Settings

```typescript
interface MpCliSettings {
  bridge: {
    url: string              // Default: http://localhost:8421
    token: string            // Auth token
    timeout: number          // Request timeout (ms)
  }
  
  display: {
    fontSize: 'small' | 'medium' | 'large'
    theme: 'light' | 'dark'
    showIcons: boolean
  }
  
  voice: {
    enabled: boolean
    language: string
    wakeWord: string | null  // Optional wake word
  }
  
  notifications: {
    enabled: boolean
    types: {
      newMessages: boolean
      calendarReminders: boolean
      taskDeadlines: boolean
    }
    quietHours: {
      enabled: boolean
      start: string          // "22:00"
      end: string            // "08:00"
    }
  }
  
  refresh: {
    auto: boolean
    interval: number         // Seconds
  }
}
```

### Settings UI

```
┌─────────────────────────────────┐
│       MP-CLI Settings           │
├─────────────────────────────────┤
│ Bridge Connection               │
│ URL: http://localhost:8421      │
│ Status: ✓ Connected             │
├─────────────────────────────────┤
│ Display                         │
│ Font Size: Medium               │
│ Theme: Dark                     │
│ Show Icons: ✓                   │
├─────────────────────────────────┤
│ Voice Commands                  │
│ Enabled: ✓                      │
│ Language: English               │
├─────────────────────────────────┤
│ Notifications                   │
│ New Messages: ✓                 │
│ Calendar: ✓                     │
│ Tasks: ✓                        │
│ Quiet Hours: 10pm - 8am         │
├─────────────────────────────────┤
│ Auto Refresh                    │
│ Enabled: ✓                      │
│ Interval: 30 seconds            │
└─────────────────────────────────┘
```

## Error Handling

### Error Types

```typescript
enum MpCliErrorType {
  BRIDGE_UNREACHABLE = 'bridge_unreachable',
  COMMAND_FAILED = 'command_failed',
  PARSE_ERROR = 'parse_error',
  DISPLAY_ERROR = 'display_error',
  GLASSES_DISCONNECTED = 'glasses_disconnected'
}

interface MpCliError {
  type: MpCliErrorType
  message: string
  details?: any
  recoverable: boolean
}
```

### Error Recovery

```typescript
// Bridge unreachable
if (error.type === MpCliErrorType.BRIDGE_UNREACHABLE) {
  // Show error message
  showError("Can't reach mp-cli bridge. Is it running?")
  
  // Retry connection
  setTimeout(() => checkConnection(), 5000)
  
  // Show cached data if available
  if (cachedData) {
    showCachedData(cachedData)
  }
}

// Command failed
if (error.type === MpCliErrorType.COMMAND_FAILED) {
  // Log error
  logError(error)
  
  // Show user-friendly message
  showError("Command failed. Please try again.")
  
  // Don't retry automatically
}

// Glasses disconnected
if (error.type === MpCliErrorType.GLASSES_DISCONNECTED) {
  // Show reconnection prompt
  showPrompt("Glasses disconnected. Reconnect?")
  
  // Attempt reconnection
  attemptReconnection()
}
```

## Performance Optimization

### 1. Caching

```typescript
interface CacheEntry {
  data: any
  timestamp: number
  ttl: number
}

class MpCliCache {
  private cache: Map<string, CacheEntry> = new Map()
  
  get(key: string): any | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    
    const age = Date.now() - entry.timestamp
    if (age > entry.ttl) {
      this.cache.delete(key)
      return null
    }
    
    return entry.data
  }
  
  set(key: string, data: any, ttl: number) {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl
    })
  }
}
```

### 2. Request Batching

```typescript
// Instead of 3 separate requests
const tasks = await executeCommand('next')
const stakeholders = await executeCommand('sh', ['list'])
const calendar = await executeCommand('calendar', ['today'])

// Batch into one request
const results = await executeBatch([
  { command: 'next' },
  { command: 'sh', args: ['list'] },
  { command: 'calendar', args: ['today'] }
])
```

### 3. Lazy Loading

```typescript
// Load dashboard immediately
loadDashboard()

// Load details on demand
onStakeholderClick(async (name) => {
  const brief = await executeCommand('sh', ['brief', name])
  showBrief(brief)
})
```

## Testing Strategy

### Unit Tests
- Command parsing
- Display formatting
- Error handling
- Cache logic

### Integration Tests
- HTTP bridge communication
- WebSocket events
- Voice command flow
- G1 display rendering

### E2E Tests
- Full user flows
- Voice → Display
- Dashboard → Brief
- Error recovery

## File Structure

```
mobile/
  src/
    components/
      mp-cli/
        MpCliApp.tsx              # Main app container
        Dashboard.tsx             # Dashboard view
        StakeholderBrief.tsx      # Brief view
        MessageView.tsx           # Message view
        CalendarView.tsx          # Calendar view
        Settings.tsx              # Settings screen
        
    services/
      MpCliBridge.ts              # Bridge interface
      MpCliCache.ts               # Caching layer
      VoiceParser.ts              # Voice command parser
      DisplayFormatter.ts         # G1 display formatter
      
    hooks/
      useMpCommand.ts             # Command execution hook
      useMpEvents.ts              # Event subscription hook
      useMpCache.ts               # Cache hook
      
    types/
      mp-cli.ts                   # TypeScript types
      
    utils/
      mp-cli-helpers.ts           # Helper functions
```

## Next Steps

1. **Review this design** - Get feedback on UX and architecture
2. **Create wireframes** - Visual mockups of each view
3. **Design G1 display specs** - Exact formatting for each view type
4. **Prototype voice parsing** - Test command recognition accuracy
5. **Build one view** - Start with Dashboard as proof of concept

## Success Criteria

- [ ] Can execute all core commands from G1
- [ ] Voice commands work 95%+ of the time
- [ ] Display is readable on G1
- [ ] < 2 second end-to-end latency
- [ ] Works offline with cached data
- [ ] Battery lasts full day
- [ ] Zero crashes in 1 week of testing
