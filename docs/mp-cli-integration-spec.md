# MP-CLI Integration with MentraOS Spec

## Overview

Integrate mp-cli (personal productivity CLI) with MentraOS to enable hands-free access to tasks, stakeholders, calendar, and messages through Even Realities G1 smart glasses.

## Goals

1. **Local-first architecture** - No backend dependency, phone ↔ glasses only
2. **Voice-driven interface** - Primary interaction via G1 microphone
3. **Contextual display** - Show relevant info on G1 display based on context
4. **Real-time updates** - Push notifications for important events

## Architecture

### Option A: HTTP Bridge (Quick Start)
```
G1 Glasses ↔ BLE ↔ MentraOS Mobile App ↔ HTTP ↔ mp-cli HTTP Server (localhost)
```

**Pros:**
- Fast to implement
- Reuses existing mp-cli commands
- Easy to test and debug

**Cons:**
- Requires mp-cli HTTP wrapper
- Extra network hop (localhost)
- Battery impact from HTTP polling

### Option B: Direct Python Bridge (Production)
```
G1 Glasses ↔ BLE ↔ MentraOS Mobile App ↔ Native Module ↔ Python Runtime ↔ mp-cli
```

**Pros:**
- No network overhead
- Better battery life
- Tighter integration

**Cons:**
- Complex setup (Python on mobile)
- Harder to debug
- Platform-specific (iOS/Android differences)

### Option C: Hybrid (Recommended)
```
G1 Glasses ↔ BLE ↔ MentraOS Mobile App ↔ Local WebView ↔ mp-cli Bridge
```

**Pros:**
- Uses existing Test Mini App pattern
- No backend needed
- Easy to iterate
- Works on both iOS/Android

**Cons:**
- Limited by WebView capabilities
- Need to expose mp-cli functionality via bridge

## Recommended Approach: Option C (Hybrid)

Build on the Test Mini App pattern we just fixed:

1. **MentraOS Local App** (WebView-based)
   - Runs locally on phone
   - Communicates with native side via MiniComms bridge
   - No internet required

2. **MP-CLI Bridge** (Native Module)
   - Exposes mp-cli commands to JavaScript
   - Runs mp-cli Python code directly or via subprocess
   - Returns results to WebView

3. **G1 Display** (via BLE)
   - Receives formatted text from native side
   - Shows contextual info based on voice commands

## Core Features (MVP)

### 1. Voice Commands
- "What's next?" → `mp next`
- "Show stakeholders" → `mp sh list`
- "Brief for [name]" → `mp sh brief <name>`
- "Today's messages" → `mp sh m c --days 1`
- "Calendar today" → `mp calendar today`

### 2. Display Modes
- **Dashboard** - Current status, next actions
- **Stakeholder Brief** - Quick info before calls
- **Message View** - Recent conversations
- **Calendar View** - Today's schedule

### 3. Notifications
- New messages from key stakeholders
- Calendar reminders
- Task deadlines
- Ball-in-court changes

## Technical Implementation

### Phase 1: Local WebView App (Week 1)

1. **Create MP-CLI Mini App**
   - Copy Test Mini App pattern
   - Add mp-cli specific UI
   - Test basic commands

2. **Build Native Bridge**
   - Add `executeMpCommand(command: string)` to MiniComms
   - Execute mp-cli via subprocess
   - Return JSON results

3. **Test on Phone**
   - Verify commands work
   - Check performance
   - Validate JSON parsing

### Phase 2: G1 Integration (Week 2)

1. **Add Display Formatting**
   - Format mp-cli output for G1 display
   - Handle text wrapping
   - Add scrolling for long content

2. **Voice Command Processing**
   - Capture voice from G1 mic
   - Parse commands locally
   - Map to mp-cli commands

3. **Test on G1**
   - Verify BLE communication
   - Check display rendering
   - Validate voice recognition

### Phase 3: Polish (Week 3)

1. **Add Caching**
   - Cache frequent queries
   - Reduce mp-cli calls
   - Improve battery life

2. **Add Notifications**
   - Push important updates to G1
   - Filter by priority
   - Respect do-not-disturb

3. **Add Settings**
   - Configure which commands are available
   - Set notification preferences
   - Customize display format

## Data Flow Examples

### Example 1: "What's next?"

1. User says "What's next?" to G1
2. G1 sends audio to phone via BLE
3. Phone transcribes to text
4. MentraOS app receives "what's next"
5. WebView calls `miniComms.executeMpCommand('next')`
6. Native bridge runs `mp next`
7. Returns JSON: `{tasks: [...], stakeholders: [...]}`
8. WebView formats for display
9. Native sends to G1 via BLE
10. G1 displays formatted text

### Example 2: "Brief for Alice"

1. User says "Brief for Alice" to G1
2. Phone transcribes to "brief for alice"
3. WebView calls `miniComms.executeMpCommand('sh brief alice')`
4. Native runs `mp sh brief alice`
5. Returns JSON with Alice's info
6. Formatted and sent to G1
7. G1 displays brief

## File Structure

```
mobile/
  src/
    components/
      mp-cli/
        MpCliApp.tsx          # Main WebView app
        MpCliDashboard.tsx    # Dashboard view
        MpCliBrief.tsx        # Stakeholder brief view
        MpCliMessages.tsx     # Message view
    services/
      MpCliBridge.ts          # Native bridge interface
    
mobile/ios/
  MpCliModule.swift           # iOS native module
  
mobile/android/
  MpCliModule.java            # Android native module
```

## Security Considerations

1. **Local Only** - No data leaves the phone
2. **Sandboxed** - mp-cli runs in isolated environment
3. **Permissions** - Request only necessary permissions (mic, contacts, calendar)
4. **Encryption** - Encrypt sensitive data at rest

## Performance Targets

- Command execution: < 500ms
- Display update: < 100ms
- Voice recognition: < 1s
- Battery impact: < 5% per hour of active use

## Open Questions

1. **Python Runtime** - How to run mp-cli Python code on mobile?
   - Option A: Bundle Python runtime (large)
   - Option B: Rewrite core mp-cli in TypeScript (time-consuming)
   - Option C: Run mp-cli on local server, connect via HTTP (requires server)

2. **Voice Command Parsing** - Local or cloud?
   - Local: Faster, more private, works offline
   - Cloud: More accurate, supports complex queries

3. **Data Sync** - How to keep mp-cli data in sync?
   - Option A: Run mp-cli on phone directly
   - Option B: Sync with desktop via iCloud/Dropbox
   - Option C: Run mp-cli on home server, VPN from phone

## Next Steps

1. **Decide on Python runtime approach** (Question 1)
2. **Create proof-of-concept** with one command (`mp next`)
3. **Test on phone** without G1 first
4. **Add G1 integration** once phone version works
5. **Iterate** based on real-world usage

## Success Metrics

- Can execute all core mp-cli commands from G1
- < 2 second end-to-end latency
- Works offline (no internet required)
- Battery lasts full day with moderate use
- Zero crashes in 1 week of testing
