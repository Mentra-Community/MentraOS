# MP-CLI Integration: Design Review & Build Plan

## G1 Display Specifications (VALIDATED)

**Hardware tested:** Even Realities G1  
**Date:** 2026-02-17

### Confirmed Constraints
- **Maximum visible lines:** 5 lines
- **Characters per line:** ~40-50 characters (varies by character width)
- **Line wrapping:** Automatic at word boundaries
- **Overflow behavior:** Text beyond 5 lines is cut off
- **Symbol support:** ✅ `→`, `•`, `📧` all render correctly
- **Formatting:** Plain text only (no bold, colors, etc.)

### Optimal Dashboard Format (5 lines)
```
→ NEXT (3)
• Alice (98%)
• Proposal (95%)
• Meeting (90%)
Ball: Me 5 | Them 12
```

**See:** `/docs/g1-display-specs.md` for complete testing results and design guidelines.

---

## Design Review

### Architecture Review

**✅ Strengths:**
1. **Local-first** - No cloud dependency, works offline
2. **Modular** - Clear separation: G1 ↔ Phone ↔ Bridge ↔ mp-cli
3. **Extensible** - Easy to add new commands/views
4. **Secure** - Localhost only, token auth
5. **Observable** - Logging, metrics, health checks

**⚠️ Concerns:**
1. **Mac dependency** - Bridge must run on Mac (acceptable for MVP)
2. **Network latency** - Phone → Mac adds ~50-100ms (acceptable)
3. **Battery impact** - HTTP polling could drain battery (mitigate with WebSocket)
4. **Python on mobile** - Not addressed yet (deferred to Phase 2)

**🔧 Recommended Changes:**
1. **Use WebSocket for events** - Replace HTTP polling with WebSocket push
2. **Add offline mode** - Cache last known state, show stale data when bridge unreachable
3. **Simplify voice parsing** - Start with exact match, add fuzzy later
4. **Defer GraphQL/gRPC** - REST is sufficient for MVP

### API Design Review

**✅ Good decisions:**
- RESTful endpoints are simple and clear
- Token auth is appropriate for local network
- Batch endpoint reduces round trips
- WebSocket for events is the right choice

**⚠️ Potential issues:**
- `/parse-voice` endpoint might be overkill - could do client-side
- Cache headers might conflict with our own caching layer
- Rate limiting might be too aggressive for single user

**🔧 Recommended Changes:**
1. **Move voice parsing to client** - Simpler, faster, works offline
2. **Remove cache headers** - Use our own cache layer only
3. **Increase rate limits** - 100/min → 1000/min (single user)

### Mobile App Design Review

**✅ Good decisions:**
- WebView pattern reuses Test Mini App fix
- Clear separation of concerns (UI, Bridge, Native)
- TypeScript types are well-defined
- Error handling is comprehensive

**⚠️ Potential issues:**
- Too many views for MVP - should start with one
- State management might be over-engineered
- G1 display formatting needs real device testing

**🔧 Recommended Changes:**
1. **Start with Dashboard only** - Defer Brief, Messages, Calendar
2. **Use React Context** - Simpler than Redux for MVP
3. **Test display on G1 early** - Don't assume formatting works

---

## Feature Prioritization

### Must Have (MVP - Week 1-2)

**P0: Core Infrastructure**
- [ ] HTTP bridge server with `/health` and `/execute` endpoints
- [ ] Mobile app with MiniComms bridge
- [ ] Basic G1 display formatting
- [ ] Connection status checking

**P0: One Command Working End-to-End**
- [ ] Voice: "What's next?" → G1 displays next actions
- [ ] Proves the entire stack works

**P0: Dashboard View**
- [ ] Show next 3 tasks
- [ ] Show ball-in-court counts
- [ ] Manual refresh button
- [ ] Error states

### Should Have (MVP+ - Week 3)

**P1: Voice Commands**
- [ ] "Show stakeholders" → List view
- [ ] "Brief for [name]" → Brief view
- [ ] "Today's messages" → Message count
- [ ] "Calendar today" → Today's events

**P1: Auto-refresh**
- [ ] WebSocket connection for events
- [ ] Push notifications to G1
- [ ] Background refresh every 30s

**P1: Settings**
- [ ] Configure bridge URL
- [ ] Enable/disable auto-refresh
- [ ] Notification preferences

### Nice to Have (Post-MVP - Week 4+)

**P2: Additional Views**
- [ ] Stakeholder Brief view
- [ ] Message conversation view
- [ ] Calendar view
- [ ] Task detail view

**P2: Advanced Features**
- [ ] Fuzzy voice matching
- [ ] Offline mode with cached data
- [ ] Multiple bridge support (home/work)
- [ ] Custom voice commands

**P3: Polish**
- [ ] Animations and transitions
- [ ] Custom G1 display themes
- [ ] Voice feedback ("Loading...")
- [ ] Haptic feedback

### Won't Have (Out of Scope)

**Deferred to Phase 2:**
- Python runtime on mobile
- TypeScript rewrite of mp-cli
- GraphQL/gRPC
- Multi-user support
- Cloud sync

---

## Build Plan

### Phase 0: Setup (Day 1)

**Goal:** Development environment ready

**Tasks:**
1. Create `mp-cli-bridge` package in mp-cli repo
2. Set up basic Flask/FastAPI server
3. Add to MentraOS mobile app:
   - `src/components/mp-cli/` directory
   - `src/services/MpCliBridge.ts`
4. Install dependencies

**Deliverable:** Empty server runs, empty app component renders

**Time estimate:** 2 hours

---

### Phase 1: HTTP Bridge MVP (Days 2-3)

**Goal:** Bridge server can execute one command

**Tasks:**
1. Implement `/health` endpoint
2. Implement `/execute` endpoint
3. Add token generation and validation
4. Add command execution (subprocess to `mp`)
5. Add error handling
6. Add logging

**Test:**
```bash
# Generate token
mp-bridge init

# Start server
mp-bridge start

# Test health
curl http://localhost:8421/api/v1/health

# Test command
curl -X POST http://localhost:8421/api/v1/execute \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"command": "next"}'
```

**Deliverable:** Can execute `mp next` via HTTP

**Time estimate:** 6 hours

---

### Phase 2: Mobile Bridge (Days 4-5)

**Goal:** Mobile app can call HTTP bridge

**Tasks:**
1. Create `MpCliBridge.ts` service
2. Implement `executeCommand()` method
3. Add HTTP client (axios/fetch)
4. Add token storage (SecureStore)
5. Add connection checking
6. Add error handling

**Test:**
```typescript
const result = await mpCliBridge.executeCommand('next')
console.log(result.data)
```

**Deliverable:** Can call bridge from mobile app

**Time estimate:** 4 hours

---

### Phase 3: Dashboard UI (Days 6-7)

**Goal:** Dashboard displays data from mp-cli

**Tasks:**
1. Create `Dashboard.tsx` component
2. Fetch data on mount
3. Display tasks, stakeholders, calendar
4. Add loading states
5. Add error states
6. Add manual refresh button

**Test:**
- Open app → see dashboard
- Pull to refresh → data updates
- Bridge offline → see error message

**Deliverable:** Working dashboard on phone

**Time estimate:** 6 hours

---

### Phase 4: G1 Display (Days 8-9)

**Goal:** Dashboard data displays on G1

**Tasks:**
1. Create `DisplayFormatter.ts`
2. Format dashboard data for G1
3. Send formatted text to G1 via BLE
4. Test on actual G1 hardware
5. Adjust formatting based on testing
6. Add scrolling for long content

**Test:**
- Open app → G1 shows dashboard
- Scroll on G1 → see more content

**Deliverable:** Dashboard visible on G1

**Time estimate:** 8 hours (includes hardware testing)

---

### Phase 5: Voice Commands (Days 10-12)

**Goal:** "What's next?" works end-to-end

**Tasks:**
1. Create `VoiceParser.ts`
2. Implement simple command matching
3. Hook up to G1 microphone
4. Parse "what's next" → "next"
5. Execute command
6. Display result on G1

**Test:**
- Say "What's next?" to G1
- See next actions on G1 display

**Deliverable:** One voice command working

**Time estimate:** 8 hours

---

### Phase 6: Additional Commands (Days 13-14)

**Goal:** 4 core voice commands working

**Tasks:**
1. Add "show stakeholders" → `sh list`
2. Add "brief for [name]" → `sh brief <name>`
3. Add "today's messages" → `sh m c --days 1`
4. Add "calendar today" → `calendar today`
5. Test each command
6. Handle edge cases

**Test:**
- Test each voice command
- Verify correct data displays

**Deliverable:** 5 total voice commands (including "what's next")

**Time estimate:** 6 hours

---

### Phase 7: Auto-refresh (Days 15-16)

**Goal:** Dashboard updates automatically

**Tasks:**
1. Implement WebSocket endpoint in bridge
2. Connect from mobile app
3. Subscribe to events
4. Update dashboard on events
5. Add reconnection logic
6. Test with real data changes

**Test:**
- Leave app open
- Send message to stakeholder
- See dashboard update automatically

**Deliverable:** Real-time updates

**Time estimate:** 8 hours

---

### Phase 8: Settings & Polish (Days 17-18)

**Goal:** Production-ready MVP

**Tasks:**
1. Create Settings screen
2. Add bridge URL configuration
3. Add notification preferences
4. Add error recovery
5. Add loading indicators
6. Test edge cases
7. Fix bugs

**Test:**
- Full regression test
- Test all error scenarios
- Test on low battery
- Test with poor network

**Deliverable:** Stable, usable MVP

**Time estimate:** 8 hours

---

## Total Time Estimate

- **Phase 0:** 2 hours
- **Phase 1:** 6 hours
- **Phase 2:** 4 hours
- **Phase 3:** 6 hours
- **Phase 4:** 8 hours
- **Phase 5:** 8 hours
- **Phase 6:** 6 hours
- **Phase 7:** 8 hours
- **Phase 8:** 8 hours

**Total:** 56 hours (~7 working days or 2-3 weeks part-time)

---

## Data Flow Diagrams

### 1. App Launch Flow

```
┌─────────┐
│  User   │
│ Opens   │
│  App    │
└────┬────┘
     │
     ▼
┌─────────────────────┐
│ MentraOS App Starts │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Check G1 Connected? │
└─────────┬───────────┘
          │
          ├─── No ──► Show "Connect G1" prompt
          │
          ▼ Yes
┌─────────────────────┐
│ Check Bridge URL    │
│ from Settings       │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ GET /health         │
└─────────┬───────────┘
          │
          ├─── Error ──► Show "Bridge Offline" error
          │              with cached data (if available)
          │
          ▼ Success
┌─────────────────────┐
│ POST /batch         │
│ - next              │
│ - sh list           │
│ - calendar today    │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Render Dashboard    │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Format for G1       │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Send to G1 via BLE  │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ G1 Displays Data    │
└─────────────────────┘
```

**Timing:**
- G1 check: 100ms
- Bridge health: 50ms
- Batch request: 300ms
- Render: 50ms
- Format: 50ms
- BLE send: 100ms
- **Total: ~650ms**

---

### 2. Voice Command Flow

```
┌─────────┐
│  User   │
│  Says   │
│ "What's │
│  next?" │
└────┬────┘
     │
     ▼
┌─────────────────────┐
│ G1 Captures Audio   │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Send Audio to Phone │
│ via BLE             │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Phone Transcribes   │
│ (Native Speech API) │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ MentraOS Receives   │
│ "what's next"       │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ VoiceParser.parse() │
│ → {command: "next"} │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ POST /execute       │
│ {command: "next"}   │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Bridge Executes     │
│ `mp next`           │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Returns JSON        │
│ {tasks: [...]}      │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Format for G1       │
│ "→ NEXT (3)         │
│  • Follow up: Alice"│
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Send to G1 via BLE  │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ G1 Displays Result  │
└─────────────────────┘
```

**Timing:**
- Audio capture: 1000ms (user speaking)
- BLE transfer: 100ms
- Transcription: 500ms
- Parse: 10ms
- HTTP request: 300ms
- Format: 50ms
- BLE send: 100ms
- **Total: ~2060ms (~2 seconds)**

---

### 3. Auto-refresh Flow (WebSocket)

```
┌─────────────────────┐
│ App Connects to     │
│ ws://bridge/events  │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Bridge Monitors     │
│ - iMessage DB       │
│ - Calendar DB       │
│ - OmniFocus DB      │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ New Message Arrives │
│ from Alice          │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Bridge Detects      │
│ Change              │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Push Event via WS   │
│ {type: "new_msg",   │
│  from: "Alice"}     │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ App Receives Event  │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Update Dashboard    │
│ (increment unread)  │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Show Notification   │
│ on G1               │
│ "📧 Alice: Hey..."  │
└─────────────────────┘
```

**Timing:**
- Event detection: <1000ms (polling interval)
- WebSocket push: 50ms
- Update UI: 50ms
- Send to G1: 100ms
- **Total: ~1200ms from event to G1**

---

### 4. Error Recovery Flow

```
┌─────────────────────┐
│ App Makes Request   │
│ POST /execute       │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Request Times Out   │
│ (5 second timeout)  │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Check Error Type    │
└─────────┬───────────┘
          │
          ├─── Network Error ──┐
          │                    │
          ├─── Timeout ────────┤
          │                    │
          └─── 500 Error ──────┤
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Check Cache         │
                    └─────────┬───────────┘
                              │
                              ├─── Has Cache ──► Show Cached Data
                              │                  + "Offline" indicator
                              │
                              └─── No Cache ───► Show Error Message
                                                 + Retry Button
                                                 
                    ┌─────────────────────┐
                    │ Start Retry Timer   │
                    │ (5s, 10s, 30s...)   │
                    └─────────┬───────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │ Retry Request       │
                    └─────────┬───────────┘
                              │
                              ├─── Success ──► Update UI
                              │                Clear Error
                              │
                              └─── Fail ─────► Continue Retry
                                               (max 3 attempts)
```

---

### 5. Stakeholder Brief Flow

```
┌─────────┐
│  User   │
│  Says   │
│ "Brief  │
│for Alice"│
└────┬────┘
     │
     ▼
┌─────────────────────┐
│ Parse Voice         │
│ → {cmd: "sh",       │
│    args: ["brief",  │
│            "alice"]}│
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ POST /execute       │
│ {command: "sh",     │
│  args: ["brief",    │
│         "alice"]}   │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Bridge Executes     │
│ `mp sh brief alice` │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Returns JSON        │
│ {name: "Alice",     │
│  lastContact: "2d", │
│  ballInCourt: "them"│
│  messages: [...],   │
│  tasks: [...]}      │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Format for G1       │
│ "ALICE JOHNSON      │
│  Last: 2d | Ball:Them│
│  📧 'Are we still...'│
│  📅 Tomorrow 3pm    │
│  → Follow up"       │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Send to G1          │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ G1 Displays Brief   │
│ (scrollable)        │
└─────────────────────┘
```

---

## Critical Path

**Must work for MVP:**
1. Bridge server starts and responds to `/health`
2. Mobile app can call bridge and get response
3. Dashboard displays on phone
4. Dashboard displays on G1
5. "What's next?" voice command works end-to-end

**Everything else is optional for MVP.**

---

## Risk Assessment

### High Risk
1. **G1 display formatting** - Unknown until tested on hardware
   - **Mitigation:** Test early (Phase 4), iterate quickly
   
2. **Voice recognition accuracy** - May not parse commands correctly
   - **Mitigation:** Start with exact match, add fuzzy later

3. **Battery drain** - HTTP polling could kill battery
   - **Mitigation:** Use WebSocket, test battery usage early

### Medium Risk
1. **Bridge reliability** - Mac must be on and reachable
   - **Mitigation:** Add offline mode with cached data
   
2. **BLE latency** - G1 ↔ Phone might be slow
   - **Mitigation:** Optimize data size, test early

3. **mp-cli performance** - Commands might be slow
   - **Mitigation:** Add caching, optimize mp-cli queries

### Low Risk
1. **Token security** - Local network only
   - **Mitigation:** Token auth is sufficient for MVP
   
2. **Error handling** - Edge cases might crash
   - **Mitigation:** Comprehensive error handling in design

---

## Success Metrics

### MVP Success (End of Week 2)
- [ ] Can say "What's next?" and see result on G1
- [ ] Dashboard updates when data changes
- [ ] Works reliably for 1 hour of continuous use
- [ ] No crashes

### Production Ready (End of Week 3)
- [ ] 5 voice commands working
- [ ] < 2 second end-to-end latency
- [ ] Works offline with cached data
- [ ] Battery lasts 8 hours with moderate use
- [ ] Zero crashes in 1 week of testing

---

## Next Steps

1. **Review this plan** - Confirm priorities and timeline
2. **Set up development environment** - Phase 0
3. **Start Phase 1** - Build HTTP bridge MVP
4. **Daily check-ins** - Review progress, adjust plan

Ready to start Phase 0?
