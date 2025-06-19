# DisplayManager Test Suite

This test suite provides a comprehensive testing framework for the DisplayManager, focused on validating real-world behaviors and edge cases rather than implementation details.

## Features

- Visual verification of display state transitions
- Time manipulation to test throttling and timeouts
- Mock user sessions and WebSockets
- Scenario-based testing approach
- Display history tracking for historical verification

## Getting Started

Run individual test files:

```bash
bun augmentos_cloud/packages/cloud/src/services/layout/tests/scenarios/basic-features.test.ts
bun augmentos_cloud/packages/cloud/src/services/layout/tests/scenarios/boot-scenarios.test.ts
bun augmentos_cloud/packages/cloud/src/services/layout/tests/scenarios/throttling-scenarios.test.ts
```

## Directory Structure

- `harness/` - Core testing infrastructure
  - `DisplayManagerTestHarness.ts` - Main test coordination class
  - `TimeMachine.ts` - Time manipulation for testing time-dependent behavior
  - `MockDisplaySystem.ts` - Display visualization and history tracking
  - `MockUserSession.ts` - User session and WebSocket simulation
- `scenarios/` - Test scenarios grouped by behavior type
  - `basic-features.test.ts` - Core functionality tests
  - `boot-scenarios.test.ts` - Boot screen and request queuing tests
  - `throttling-scenarios.test.ts` - Throttling and per-app queue tests
- `utilities/` - Helper functions and assertions

## Core Testing Concepts

### Time Control

The `TimeMachine` class allows tests to manipulate time, which is essential for testing:
- Throttle delays (300ms)
- Boot screen durations (1500ms)
- Display expiration timers

```typescript
// Advance time to complete boot screen (1500ms)
harness.advanceTime(1500);

// Add a small additional advance to process any pending callbacks
harness.advanceTime(50);
```

### Display Assertion Methods

The test harness provides different methods for verifying display behavior:

1. **assertAppDisplaying(packageName)**: Checks that an app is currently displaying or has displayed content recently (checks both current display and history).

2. **assertDisplayShowingNow(content)**: Verifies specific content is displayed (more stringent).

3. **assertBootScreenShowing()**: Specifically checks for the boot screen.

### History Tracking

The `MockDisplaySystem` tracks:
- Current display state
- Display history (all past displays)
- Boot and throttle queues

This allows tests to verify that a display was shown, even if it's no longer the active display.

## Common Testing Patterns

### Testing Boot Queue Behavior

When testing boot queue behavior, remember:

1. Start an app to trigger boot screen (1500ms duration)
2. Send display requests during boot phase
3. Verify requests are queued (not shown immediately)
4. Advance time past boot duration: `harness.advanceTime(1500)`
5. Add a small additional time advance to process callbacks: `harness.advanceTime(50)`
6. Verify the queued displays are processed correctly

```typescript
// Start app (triggers boot screen)
harness.startApp('com.example.app1');

// Send display request during boot
harness.sendDisplayRequest(APP1, 'Hello from App1');

// Verify boot screen is showing (not the app display)
harness.assertBootScreenShowing();

// Advance time to complete boot
harness.advanceTime(1500);
harness.advanceTime(50);  // Add small delay for callback processing

// Verify the app's display is now shown
harness.assertAppDisplaying(APP1);
```

### Testing Throttling Behavior

When testing throttling behavior:

1. Send initial display request (should show immediately)
2. Send subsequent requests rapidly (should be throttled)
3. Verify only the first display is shown initially
4. Advance time past throttle delay: `harness.advanceTime(305)`
5. Add a small additional time advance: `harness.advanceTime(50)`
6. Verify throttled displays are processed correctly

```typescript
// Send first display (shows immediately)
harness.sendDisplayRequest(APP1, 'Display A');
harness.assertAppDisplaying(APP1);

// Send second display immediately (will be throttled)
harness.sendDisplayRequest(APP1, 'Display B');

// First display should still be showing
harness.assertAppDisplaying(APP1);

// Advance time past throttle window
harness.advanceTime(305);
harness.advanceTime(50);  // Add small delay for callback processing

// Now display B should be showing
harness.assertAppDisplaying(APP1);
// For exact content verification: harness.assertDisplayShowingNow('Display B');
```

### Testing Multi-App Interactions

When testing interactions between multiple apps:

1. Send display requests from different apps
2. Verify per-app throttling works correctly
3. Check priority behavior between apps

```typescript
// App1 sends display
harness.sendDisplayRequest(APP1, 'App1 Display');
harness.assertAppDisplaying(APP1);

// App2 sends display (may be throttled)
harness.sendDisplayRequest(APP2, 'App2 Display');

// App1 might still be showing due to throttling
// Advance time to process throttled displays
harness.advanceTime(305);
harness.advanceTime(50);

// Check result based on expected behavior
// (depends on specific priority rules)
```

## Troubleshooting Tests

### Common Issues

1. **Timing Issues**: If displays aren't showing when expected, try adding a small additional time advance (50ms) to allow callbacks to process:
   ```typescript
   harness.advanceTime(1500); // Main time advance
   harness.advanceTime(50);   // Allow callbacks to execute
   ```

2. **Display Content vs App Display**: Use `assertAppDisplaying()` when you only care that an app's content is showing (or was shown recently), and use `assertDisplayShowingNow()` when you need to verify exact content.

3. **WebSocket Limitations**: The mock WebSocket implementation may behave slightly differently than a real WebSocket. The test harness handles most of these differences but be aware of potential edge cases.

## Visual Output

The tests produce a visual representation of what would appear on the glasses display, making it easy to understand and debug issues:

```
[MockDisplaySystem]
┌─────────────────────────────────────────────────┐
│ CURRENT DISPLAY (main view)                     │
│                                                 │
│ Package: com.example.myapp                      │
│ Layout: TEXT_WALL                               │
│ Content: "Hello, this is my display content"    │
│                                                 │
│ Sent at: 10:15:32.456                           │
└─────────────────────────────────────────────────┘
```

## Timeline View

For complex scenarios, a timeline view shows the sequence of events and display changes:

```
TIME     | EVENT                             | DISPLAY SHOWN        | QUEUES
---------|-----------------------------------|----------------------|------------
0:00.000 | App1 starts                       | Boot Screen          | -
0:00.050 | App1 sends Display A              | Boot Screen          | Boot: App1-A
0:01.500 | Boot completes                    | App1-A               | -
```

## Writing New Tests

When writing new tests:

1. Use the existing test files as templates
2. Focus on testing behavior, not implementation details
3. Make sure to handle timing correctly with appropriate time advances
4. Use the most appropriate assertion methods for your test case
5. Verify both immediate behavior and historical tracking as needed
6. Add console logs for clarity in debugging failing tests