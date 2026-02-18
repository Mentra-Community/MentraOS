# MP Dashboard - Design Specification
## Inspired by Even Realities G2 Dashboard

**Version:** 1.0  
**Date:** 2026-02-18  
**Author:** Based on Even Realities G2 UX patterns  
**Target Device:** Even Realities G1 (640x200 monochrome green display)

---

## 1. EXECUTIVE SUMMARY

### Vision
Create a comprehensive personal productivity dashboard for G1 glasses that provides "continuous foresight" - keeping the user informed of commitments, tasks, and contextual information at a glance.

### Core Philosophy
- **Glanceable**: Information visible in <2 seconds
- **Contextual**: Right information at the right time
- **Offline-first**: Works without backend/internet
- **Unobtrusive**: Background app, doesn't interfere with other apps

---

## 2. FEATURE COMPARISON: G2 vs G1

### G2 Capabilities (Reference)
- **Display**: Color, higher resolution
- **Input**: TouchPad (swipe up/down, tap, double-tap, long-press)
- **R1 Ring**: Bluetooth controller with TouchPad
- **Voice**: "Hey Even" wake word, continuous conversation
- **AI**: Real-time conversation analysis, contextual cues

### G1 Capabilities (Our Target)
- **Display**: 640x200 monochrome green, 5 text lines max
- **Input**: Head gestures (up/down), NO tap events exposed to apps
- **Buttons**: External Bluetooth button (future integration)
- **Voice**: Microphone available (via Live Captions integration)
- **Processing**: Phone-based (offline capable)

### Key Constraints
1. **NO tap event access** - G1 firmware handles taps internally
2. **Limited display** - 5 lines, monochrome, lower resolution than G2
3. **No swipe events** - Head gestures only for navigation
4. **Simpler interaction model** - Must work with minimal input

---

## 3. DASHBOARD ARCHITECTURE

### 3.1 Widget System

#### Widget Types (Priority Order)
1. **OmniFocus Tasks** (via `mp next`)
   - Next action with context
   - Priority indicator
   - Project/tag info
   
2. **Calendar Events** (via `mp forecast`)
   - Today's schedule
   - Next meeting
   - Time until next event

3. **Weather** (via `mp weather` or API)
   - Current conditions
   - Temperature
   - Forecast summary

4. **Time/Date Status**
   - Current time
   - Date/weekday
   - Battery level

5. **Latin Learning** (custom)
   - Vocabulary flashcards
   - Spaced repetition
   - Daily word

6. **Notifications** (future)
   - Unread messages
   - Important alerts

#### Widget Structure
```
┌─────────────────────────────────┐
│ STATUS BAR (Line 1)             │  ← Time, Date, Battery
├─────────────────────────────────┤
│ WIDGET TITLE (Line 2)           │  ← "NEXT TASK" / "CALENDAR"
├─────────────────────────────────┤
│ Content Line 1                  │
│ Content Line 2                  │  ← Widget-specific content
│ Content Line 3                  │
└─────────────────────────────────┘
```

### 3.2 Navigation Model

#### Without Tap Events (G1 Limitation)
**Option A: Auto-Rotation**
- Widgets rotate automatically every N seconds
- Configurable rotation speed (30s, 60s, 120s)
- Status bar always visible

**Option B: Head Gesture Navigation** (if available)
- Head-up: Next widget
- Head-down: Previous widget
- Requires head gesture detection integration

**Option C: Time-Based Contextual** (Recommended)
- Morning (6am-12pm): Calendar + Tasks
- Afternoon (12pm-6pm): Tasks + Weather
- Evening (6pm-12am): Tomorrow's calendar
- Smart switching based on context

**Option D: Bluetooth Button** (Future)
- Single press: Next widget
- Double press: Refresh current widget
- Long press: Toggle dashboard on/off

### 3.3 Data Sources

#### MP-CLI Commands
```bash
mp next          # Next OmniFocus task
mp forecast      # Today's calendar
mp today         # Today's tasks
mp weather       # Weather info
mp inbox         # Inbox count
```

#### Data Refresh Strategy
- **Active refresh**: Every 60 seconds (current)
- **Smart refresh**: Only when data changes
- **Manual refresh**: Via button or voice command
- **Background sync**: Update cache when app inactive

---

## 4. WIDGET SPECIFICATIONS

### 4.1 OmniFocus Tasks Widget

**Display Format:**
```
12:45 PM  Wed Feb 18  [==]  ← Status bar
─────────────────────────────
→ NEXT (1)                    ← Widget title
Follow up: Natalie Monroe     ← Task name
Priority: 10/10               ← Priority
                              ← Empty line
OTHER SIGNALS (2)             ← Context/count
```

**Data Fields:**
- Task name (truncated to fit)
- Priority (1-10 scale)
- Project/context
- Due date (if today/overdue)
- Count of other tasks

**Refresh:** Every 60s or on completion

### 4.2 Calendar Widget

**Display Format:**
```
12:45 PM  Wed Feb 18  [==]
─────────────────────────────
📅 TODAY
2:00 PM - Team Meeting        ← Next event
In 1h 15m                     ← Time until
                              
3 more events today           ← Count
```

**Data Fields:**
- Next event time + title
- Time until event
- All-day events
- Tomorrow preview (if evening)

**Refresh:** Every 5 minutes

### 4.3 Weather Widget

**Display Format:**
```
12:45 PM  Wed Feb 18  [==]
─────────────────────────────
☀️ WEATHER
Sunny, 72°F                   ← Current
High 75° / Low 58°            ← Forecast
                              
Good day for a walk!          ← Context
```

**Data Fields:**
- Current conditions
- Temperature
- High/low forecast
- Contextual message

**Refresh:** Every 30 minutes

### 4.4 Latin Learning Widget

**Display Format:**
```
12:45 PM  Wed Feb 18  [==]
─────────────────────────────
📖 LATIN WORD
carpe diem                    ← Latin
"seize the day"               ← English
                              
Used in: Horace, Odes         ← Context
```

**Data Fields:**
- Latin word/phrase
- English translation
- Usage context
- Spaced repetition schedule

**Refresh:** Daily or on demand

---

## 5. INTERACTION DESIGN

### 5.1 Current Implementation (Working)
- **Auto-refresh**: Every 60 seconds
- **Display**: Automatic send to glasses
- **Control**: None (passive display)

### 5.2 Phase 2: Bluetooth Button Integration

**Button Mapping:**
| Action | Function |
|--------|----------|
| Single press | Next widget |
| Double press | Refresh current |
| Long press | Toggle dashboard |
| Triple press | Mark task complete |

### 5.3 Phase 3: Voice Commands

**Wake Word:** "Hey Mentra" (or use existing Live Captions)

**Commands:**
- "Show next task"
- "What's my schedule?"
- "Mark task complete"
- "Refresh dashboard"
- "Show weather"
- "Latin word"

---

## 6. TECHNICAL ARCHITECTURE

### 6.1 Current Implementation
```
MpCliService (60s timer)
    ↓
mpCliBridge.executeCommand('next')
    ↓
DisplayFormatter.formatNext(data)
    ↓
miniComms.sendToGlasses(text)
```

### 6.2 Proposed Widget System
```
DashboardManager
  ├─ WidgetRegistry
  │   ├─ OmniFocusWidget
  │   ├─ CalendarWidget
  │   ├─ WeatherWidget
  │   └─ LatinWidget
  │
  ├─ RotationController
  │   ├─ Auto-rotation timer
  │   ├─ Context-based switching
  │   └─ Manual navigation
  │
  ├─ DataManager
  │   ├─ MP-CLI bridge
  │   ├─ Calendar API
  │   ├─ Weather API
  │   └─ Local storage
  │
  └─ DisplayManager
      ├─ Format for G1
      ├─ Status bar
      └─ Send to glasses
```

### 6.3 Widget Interface
```typescript
interface Widget {
  id: string
  name: string
  priority: number
  refreshInterval: number
  
  fetchData(): Promise<WidgetData>
  formatDisplay(data: WidgetData): string
  shouldShow(context: Context): boolean
}
```

---

## 7. DISPLAY FORMATTING

### 7.1 G1 Display Constraints
- **Resolution**: 640x200 pixels
- **Text lines**: 5 maximum
- **Characters per line**: ~40 (depends on font)
- **Color**: Monochrome green
- **Brightness**: Adjustable

### 7.2 Formatting Rules
1. **Status bar**: Always line 1
2. **Widget title**: Always line 2
3. **Content**: Lines 3-5
4. **Truncation**: Use "..." for overflow
5. **Alignment**: Left-aligned
6. **Spacing**: Blank lines for readability

### 7.3 Icon Substitution
G1 doesn't support emoji/icons well, use text:
- `→` for next/action
- `📅` → `[CAL]`
- `☀️` → `[SUN]`
- `📖` → `[BOOK]`
- `✓` for complete
- `!` for urgent

---

## 8. IMPLEMENTATION PHASES

### Phase 1: Enhanced Widget System (Current Sprint)
- [ ] Create Widget base class
- [ ] Implement OmniFocus widget (done)
- [ ] Add Calendar widget
- [ ] Add Weather widget
- [ ] Implement auto-rotation
- [ ] Add widget configuration UI

### Phase 2: Smart Context & Controls
- [ ] Context-based widget switching
- [ ] Bluetooth button integration
- [ ] Manual refresh controls
- [ ] Widget enable/disable settings
- [ ] Refresh interval configuration

### Phase 3: Advanced Features
- [ ] Latin learning widget
- [ ] Voice command integration
- [ ] Task completion from glasses
- [ ] Notification integration
- [ ] Health/fitness data (if available)

### Phase 4: Teleprompt Integration
- [ ] Script storage
- [ ] Auto-scroll modes
- [ ] Voice-follow scrolling
- [ ] Presentation timer

---

## 9. CONFIGURATION

### 9.1 User Settings
```typescript
interface DashboardSettings {
  // Widget configuration
  enabledWidgets: string[]
  widgetOrder: string[]
  
  // Rotation
  rotationMode: 'auto' | 'contextual' | 'manual'
  rotationInterval: number // seconds
  
  // Data sources
  mpCliUrl: string
  mpCliApiKey: string
  
  // Display
  statusBarEnabled: boolean
  compactMode: boolean
  
  // Refresh
  globalRefreshInterval: number
  smartRefresh: boolean
}
```

### 9.2 Widget-Specific Settings
Each widget can have custom settings:
- Refresh interval
- Data filters
- Display preferences
- Priority/importance

---

## 10. SUCCESS METRICS

### User Experience
- **Glance time**: <2 seconds to understand info
- **Accuracy**: 100% data correctness
- **Latency**: <1 second from refresh to display
- **Battery**: <5% additional drain

### Technical
- **Uptime**: 99.9% (offline app)
- **Refresh reliability**: 100% success rate
- **Data freshness**: <60 seconds old
- **Memory**: <50MB RAM usage

---

## 11. FUTURE ENHANCEMENTS

### Teleprompt Feature
- Import scripts (TXT, DOCX, PDF)
- Auto-scroll with voice-follow
- Presentation timer
- Half/full screen toggle

### Conversate Feature (G1 Limitations)
- Real-time transcription (already have via Live Captions)
- AI summary (requires backend/LLM)
- Contextual cues (requires AI processing)
- Limited by G1 display size

### Translation Feature
- Real-time translation
- Dual language display
- Voice input
- Limited by display size

---

## 12. OPEN QUESTIONS

1. **Head gesture access**: Can we detect head-up/down in apps?
2. **Bluetooth button protocol**: What's the API for external buttons?
3. **Voice integration**: How to integrate with Live Captions mic?
4. **Battery impact**: What's acceptable for background app?
5. **Display persistence**: How long should info stay on screen?

---

## 13. REFERENCES

- Even Realities G2 Dashboard: https://support.evenrealities.com/hc/en-us/articles/14269247458319
- Even Realities G2 Teleprompt: https://support.evenrealities.com/hc/en-us/articles/14273863878415
- Even Realities G2 Conversate: https://support.evenrealities.com/hc/en-us/articles/14273795154319
- Even Realities G2 Translate: https://support.evenrealities.com/hc/en-us/articles/14273831059983
- Even Realities G2 AI: https://support.evenrealities.com/hc/en-us/articles/14274515708559
- G1 Display Specs: 640x200 monochrome, 5 lines max

---

## APPENDIX A: MP-CLI Command Reference

```bash
# Task management
mp next              # Next action
mp today             # Today's tasks
mp forecast          # Calendar forecast
mp inbox             # Inbox count

# Context
mp weather           # Weather info
mp time              # Current time

# Custom (to implement)
mp latin             # Latin word of the day
mp complete <id>     # Mark task complete
```

---

## APPENDIX B: G1 vs G2 Feature Matrix

| Feature | G2 | G1 | Notes |
|---------|----|----|-------|
| Dashboard | ✅ | 🚧 | Building |
| Widgets | ✅ | 🚧 | Simplified |
| Tap events | ✅ | ❌ | Firmware only |
| Swipe events | ✅ | ❌ | No access |
| Head gestures | ✅ | ⚠️ | Limited |
| Voice wake | ✅ | ⚠️ | Via Live Captions |
| AI features | ✅ | ❌ | Requires backend |
| Teleprompt | ✅ | 🔮 | Future |
| Translation | ✅ | 🔮 | Future |
| Color display | ✅ | ❌ | Monochrome |
| Resolution | High | 640x200 | Lower |
| R1 Ring | ✅ | ❌ | BT button instead |

Legend: ✅ Full support | 🚧 In progress | ⚠️ Partial | ❌ Not available | 🔮 Planned
