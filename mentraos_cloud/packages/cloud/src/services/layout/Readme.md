# Smart Glasses Display Management System

## System Architecture

### Components

1. **Third Party Applications (TPAs)**
   - Server-side applications that connect via WebSocket
   - Can request display updates at any time
   - Can specify arbitrary view names
   - Have lifecycle states: starting, running, stopped
   - Can crash or disconnect unexpectedly

2. **Client (Smart Glasses)**
   - Connected via Bluetooth Low Energy (BLE)
   - Understands two view types:
     * Dashboard - Client-side cached/managed
     * Main View - All non-dashboard content
   - View switching based on head position:
     * Look up = dashboard
     * Look down = main view
   - BLE limitations require careful message rate management

3. **DisplayManager (Server)**
   - Central manager for all display requests
   - Handles throttling, priority, and display stack
   - Manages boot screens and app state transitions
   - Maintains display history

## Core Requirements

### Display Throttling
- 200ms minimum between non-dashboard displays
- Required for:
  * BLE connection stability
  * Smooth UI/UX experience
  * Preventing visual jarring
- Dashboard view bypasses throttling (client-managed)

### Display Stack System
- Multiple TPAs can have active display requests
- Single active request per TPA
- When TPA sends new request:
  * All previous requests from that TPA are removed
  * New request added (respecting throttle)
  * Duration handling reset
- Priority based on runningApps order in userSession

### Duration Handling
1. **Null Duration Displays**
   - Persist until:
     * Any TPA sends new request
     * Explicitly cleared
     * Owning app stops/crashes
   
2. **Timed Duration Displays**
   - Auto-remove after specified duration
   - Or end early from above conditions
   - Duration timer not preserved if TPA sends new request

### Boot Screen Management
1. **Timing**
   - Shows for 3 seconds per app start
   - Timer resets with each new app start
   - Highest display priority while active

2. **Layout (text_rows)**
   - Dynamic rows based on content:
     ```
     Booting...
     [App1, App2, +N more]     # If any booting
     Running...                 # Only if apps running
     [App1, App2, +N more]     # Running apps
     ```
   - Max 2 apps per row plus "+N more" notation
   - "Running..." section only shown if apps are running

3. **State Transitions**
   - Apps move from booting → running after 3s
   - Stay in running until explicitly stopped
   - Removing last running app removes "Running..." section

### App Lifecycle
1. **Starting**
   - Added to boot screen
   - Starts 3s timer
   - Can send display requests (queued)

2. **Running**
   - Moved to running section after 3s
   - Can send and clear displays
   - Participates in display stack

3. **Stopping/Crashing**
   - Remove from boot screen
   - Clear all display requests
   - Update display stack
   - Remove from running apps

## Edge Cases & Special Handling

### Connection Issues
1. **TPA Disconnects**
   - Clear all their display requests
   - Remove from boot screen
   - Show next priority display

2. **Client Disconnects**
   - Maintain display state
   - Update userSession websocket on reconnect
   - Resume from previous state

### Display Conflicts
1. **Multiple High-Priority Requests**
   - Honor throttle timing
   - Use runningApps order for priority
   - Maintain request stack

2. **Boot Screen Active**
   - Queue all display requests
   - Nothing shows until boot complete
   - Preserve request order/priority

3. **Display Duration Overlap**
   - Honor most recent request per TPA
   - Maintain other TPAs' requests
   - Reset timers for new requests

### Error Conditions
1. **App Crashes**
   - Clean removal from boot screen
   - Clear all display requests
   - Update running apps list

2. **Invalid Display Requests**
   - Validate before processing
   - Log errors
   - Maintain system stability

3. **WebSocket Errors**
   - Handle disconnects gracefully
   - Maintain system state
   - Allow reconnection

## User Stories

1. **As a user starting multiple apps:**
   - See boot screen with all loading apps
   - Clear indication of which are booting/running
   - Smooth transition to app displays

2. **As a user switching views:**
   - Instant dashboard access on look up
   - Current main view on look down
   - No jarring transitions

3. **As a TPA developer:**
   - Can request displays anytime
   - Understand priority system
   - Clear duration management

4. **As a system admin:**
   - Monitor display management
   - Track app states
   - Handle errors gracefully

## Performance Considerations

1. **BLE Bandwidth**
   - Respect 200ms throttle
   - Minimize unnecessary updates
   - Handle reconnections

2. **Memory Management**
   - Clean up old display history
   - Remove inactive requests
   - Clear stopped app data

3. **State Consistency**
   - Maintain accurate app states
   - Handle race conditions
   - Preserve priority order

## Technical Implementation Notes

1. **Display Request Format**
   ```typescript
   interface DisplayRequest {
     view: string;
     packageName: string;
     layout: Layout;
     duration?: number;
     // ... other properties
   }
   ```

2. **Priority Management**
   - Based on userSession.runningApps order
   - Lower index = higher priority
   - Dynamic updates on app state changes

3. **Boot Screen Updates**
   - Triggered by app state changes
   - Dynamic content formatting
   - Automatic cleanup

## Recent Improvements (7 April 2025)

1. **Boot Queue Processing**
   - Display requests during boot are now queued rather than rejected
   - Ensures developers' initial display content is shown after boot
   - Preserves the intended first-time experience for users

2. **Per-App Throttling System**
   - Each app has its own throttling queue
   - One app's rapid updates don't interfere with other apps
   - Most recent request per app is always displayed eventually

3. **Fixed Throttle Recovery Logic**
   - Apps can now update their own display content through throttling
   - Prevents "stuck" displays when apps send multiple updates
   - Ensures the most recent content is always shown

4. **Improved Testing Framework**
   - Comprehensive test scenarios for throttling and boot behavior
   - Time-controlled testing environment for consistent results
   - Display history tracking for verifying correct behavior
   - See `tests/README.md` for details on testing the DisplayManager

## Future Considerations

1. **Performance Monitoring**
   - Display request latency tracking
   - BLE connection stability
   - Error rate monitoring

2. **Enhanced Priority System**
   - Dynamic priority adjustments
   - User preference integration
   - Context-aware priorities

3. **Extended Display Types**
   - Additional layout types
   - Enhanced duration controls
   - Transition effects