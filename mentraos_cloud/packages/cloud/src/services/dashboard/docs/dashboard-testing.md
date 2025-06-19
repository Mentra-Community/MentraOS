# Dashboard System Testing

## Overview

This document outlines the testing strategy for the dashboard system. Testing the dashboard is done through a combination of the test harness, which simulates both TPAs and the display manager, and manual validation with actual hardware.

## Testing Approach

### Test Harness

The test harness provides a controlled environment to test dashboard functionality without requiring actual hardware. It includes:

1. **MockDisplayManager**: Simulates the display manager by rendering layouts to the terminal
2. **MockWebSocketService**: Simulates the WebSocket service by providing message handlers and broadcasting
3. **DashboardTestHarness**: Orchestrates tests and provides helper methods for common operations

### Test Scenarios

The test harness includes several built-in test scenarios:

#### Basic Test

Tests basic dashboard functionality:
- System section updates
- Dashboard mode changes
- TPA content updates for different modes
- Always-on overlay functionality

#### App Lifecycle Test

Tests how the dashboard handles app lifecycle events:
- App starting (adding content)
- App updating content
- App stopping (content removal)
- Multiple apps interacting with the dashboard

### How to Run Tests

Run tests using the provided script:

```bash
# From the packages/cloud directory
bun run src/services/dashboard/tests/run-tests.ts
```

### Test Output

The test harness outputs visual representations of dashboard layouts to the terminal:

```
=== dashboard ===
[topLeft]: Time: 12:34
[topRight]: Battery: 85%
[center]: Weather: Sunny, 72°F

Meeting with Team @ 1:00 PM

New message from John: "Are we still on for lunch?"
[bottomLeft]: Notifications: 3
[bottomRight]: Status: Connected
================
```

## Terminal Visualization

The test harness renders dashboard layouts to the terminal to help visualize the output. Each section is displayed with its key and content.

### Sample Visualization

```
=== dashboard ===
[topLeft]: Time: 12:34
[topRight]: Battery: 85%
[center]: Weather: Sunny, 72°F
[bottomLeft]: Notifications: 3
[bottomRight]: Status: Connected
================

--- OVERLAY ---
=== dashboard_always_on ===
[left]: Time: 12:34
[right]: Battery: 85%
[tpaContent]: Steps: 5,280
================
--------------
```

## Hardware Validation

After terminal testing, validation should be performed with actual hardware to ensure:

1. Layout rendering is correct on the glasses display
2. Updates are properly throttled for hardware limitations
3. Content from multiple TPAs is displayed correctly
4. Mode transitions work as expected

## Custom Test Cases

The test harness can be extended to create custom test cases:

```typescript
// Create a custom test
const harness = new DashboardTestHarness();

// Set up initial state
harness.updateSystemSection('topLeft', 'Time: 13:45');
harness.changeDashboardMode(DashboardMode.MAIN);

// Add content from a TPA
harness.sendTpaContent('com.example.app', 'Custom test content');

// Check the current state
const mode = harness.getCurrentMode();
const layout = harness.getCurrentLayout();
console.log(`Current mode: ${mode}`);
console.log('Current layout:', layout);
```

## Dashboard Manager API Testing

The test harness allows testing of the DashboardManager API:

- `getCurrentMode()`: Get the current dashboard mode
- `isAlwaysOnEnabled()`: Check if always-on dashboard is enabled
- `setAlwaysOnEnabled(enabled)`: Set always-on dashboard state

## Automated Testing

While the current tests are interactive, they can be extended to include assertions for automated validation:

```typescript
function runAutomatedTest() {
  const harness = new DashboardTestHarness();
  
  // Set up test
  harness.updateSystemSection('topLeft', 'Test');
  harness.changeDashboardMode(DashboardMode.MAIN);
  
  // Get layout
  const layout = harness.getCurrentLayout();
  
  // Assert expected values
  console.assert(
    layout?.sections?.topLeft === 'Test',
    'topLeft section should contain "Test"'
  );
  
  console.assert(
    harness.getCurrentMode() === DashboardMode.MAIN,
    'Dashboard mode should be MAIN'
  );
  
  console.log('All tests passed!');
}
```