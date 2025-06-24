---
sidebar_position: 9
title: Dashboard API
---

# Dashboard API Reference

The Dashboard API provides an interface for displaying real-time information and status updates directly on the user's MentraOS glasses. It allows your TPA to send content to different dashboard modes and react to user interactions with the dashboard.

## Import

```typescript
import { TpaServer, TpaSession, DashboardMode } from '@mentra/sdk';

export class MyTpaServer extends TpaServer {
  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    // Access the dashboard API
    const dashboard = session.dashboard;

    // Send content to the main dashboard
    dashboard.content.writeToMain('🔄 Processing...');

    // Send detailed content to expanded view
    dashboard.content.writeToExpanded('Processing file: document.pdf\nProgress: 45%');

    // Listen for dashboard mode changes
    dashboard.content.onModeChange((mode) => {
      console.log(`Dashboard mode changed to: ${mode}`);
      this.updateContentForMode(mode);
    });
  }

  private updateContentForMode(mode: DashboardMode): void {
    if (mode === DashboardMode.MAIN) {
      session.dashboard.content.writeToMain('📊 Quick Stats');
    } else if (mode === DashboardMode.EXPANDED) {
      session.dashboard.content.writeToExpanded('📊 Detailed Analytics\n\nFiles processed: 1,234\nSuccess rate: 98.5%\nLast update: 2 min ago');
    }
  }
}
```

## Overview

Every [`TpaSession`](/reference/tpa-session) exposes a `dashboard` property that provides access to the Dashboard API:

| Property | Type | Purpose |
| :------- | :--- | :------ |
| `session.dashboard.content` | [`DashboardContentAPI`](#class-dashboardcontentapi) | Interface for writing content to the dashboard |

The SDK automatically converts your method calls into WebSocket messages that the MentraOS cloud routes to the user's glasses. You never have to construct layouts manually - simply provide text content and specify which dashboard mode(s) should display it.

## Enum: DashboardMode

The `DashboardMode` enum defines the different display modes available on the MentraOS dashboard.

```typescript
enum DashboardMode {
  MAIN = 'main',       // Standard compact dashboard (default)
  EXPANDED = 'expanded' // Larger dashboard when user opens it explicitly
  // ALWAYS_ON = 'always_on'  // Compact overlay (coming soon)
}
```

**Values:**
- `MAIN`: The default compact dashboard mode that appears as a small overlay
- `EXPANDED`: The full-screen dashboard mode that users can open for detailed information
- `ALWAYS_ON`: *(Coming soon)* A persistent compact overlay mode

Use these values whenever a method accepts a `mode` parameter or when checking the current dashboard state.

## Class: DashboardContentAPI

The `DashboardContentAPI` class provides methods for sending content to the dashboard and monitoring dashboard state changes. It is automatically instantiated by the `TpaSession` and available at `session.dashboard.content`.

### Constructor

The DashboardContentAPI is automatically instantiated by the TpaSession. You should not create instances directly.

```typescript
class DashboardContentAPI {
  constructor(
    private wsConnection: WebSocketConnection,
    private packageName: string
  )
}
```

## Methods

### write

Send content to one or more dashboard modes.

```typescript
write(content: string, targets?: DashboardMode[]): void
```

**Parameters:**
- `content`: The text content to display on the dashboard
- `targets`: Array of dashboard modes to target. Defaults to `[DashboardMode.MAIN]`

**Returns:** void

**Example:**
```typescript
// Send to main dashboard only (default behavior)
session.dashboard.content.write('✅ Task completed');

// Send to multiple modes
session.dashboard.content.write(
  'System Status: Online',
  [DashboardMode.MAIN, DashboardMode.EXPANDED]
);

// Send different content to expanded mode
session.dashboard.content.write(
  'System Status: Online\n\nCPU: 45%\nMemory: 2.1GB\nUptime: 3d 14h',
  [DashboardMode.EXPANDED]
);
```

### writeToMain

Convenience method for sending content specifically to the main dashboard mode.

```typescript
writeToMain(content: string): void
```

**Parameters:**
- `content`: The text content to display in main mode

**Returns:** void

**Example:**
```typescript
// These are equivalent:
session.dashboard.content.writeToMain('🔄 Processing...');
session.dashboard.content.write('🔄 Processing...', [DashboardMode.MAIN]);

// Common use cases
session.dashboard.content.writeToMain('📧 3 new messages');
session.dashboard.content.writeToMain('🎵 Now playing: Song Title');
session.dashboard.content.writeToMain('⚠️ Low battery: 15%');
```

### writeToExpanded

Convenience method for sending content specifically to the expanded dashboard mode.

```typescript
writeToExpanded(content: string): void
```

**Parameters:**
- `content`: The text content to display in expanded mode

**Returns:** void

**Example:**
```typescript
// These are equivalent:
session.dashboard.content.writeToExpanded('Detailed information here...');
session.dashboard.content.write('Detailed information here...', [DashboardMode.EXPANDED]);

// Expanded content can include more details
session.dashboard.content.writeToExpanded(`
📊 Daily Summary

Tasks completed: 8/10
Time spent: 6h 23m
Focus score: 87%

Next meeting: 2:30 PM
Location: Conference Room B
`);
```

### getCurrentMode

Get the dashboard mode currently visible on the user's glasses.

```typescript
getCurrentMode(): Promise<DashboardMode | 'none'>
```

**Returns:** Promise that resolves to the current dashboard mode, or `'none'` if the dashboard is closed

**Example:**
```typescript
const currentMode = await session.dashboard.content.getCurrentMode();

if (currentMode === 'none') {
  console.log('Dashboard is closed');
} else if (currentMode === DashboardMode.MAIN) {
  console.log('Main dashboard is visible');
  // Send appropriate content for main mode
  session.dashboard.content.writeToMain('Quick update');
} else if (currentMode === DashboardMode.EXPANDED) {
  console.log('Expanded dashboard is visible');
  // Send detailed content for expanded mode
  session.dashboard.content.writeToExpanded('Detailed status information...');
}
```

### onModeChange

Register a callback function that will be called whenever the dashboard mode changes.

```typescript
onModeChange(handler: (mode: DashboardMode | 'none') => void): () => void
```

**Parameters:**
- `handler`: Function called when the dashboard mode changes. Receives the new mode as a parameter

**Returns:** Cleanup function to remove the event listener

**Example:**
```typescript
// Register mode change handler
const unsubscribe = session.dashboard.content.onModeChange((mode) => {
  console.log(`Dashboard mode changed to: ${mode}`);

  switch (mode) {
    case DashboardMode.MAIN:
      // User collapsed to main view - show compact info
      session.dashboard.content.writeToMain('📊 Status: OK');
      break;

    case DashboardMode.EXPANDED:
      // User expanded dashboard - show detailed info
      session.dashboard.content.writeToExpanded(`
📊 System Status

🟢 All systems operational
📈 Performance: 98.2%
🔧 Last maintenance: 2 days ago
📅 Next check: Tomorrow 9:00 AM
      `);
      break;

    case 'none':
      // Dashboard was closed
      console.log('Dashboard closed by user');
      break;
  }
});

// Clean up the listener when done
// unsubscribe();
```

## Interface: DashboardAPI

The main dashboard interface that contains all dashboard-related functionality.

```typescript
interface DashboardAPI {
  content: DashboardContentAPI;
}
```

Every `TpaSession` constructs this object and assigns it to `session.dashboard`. Currently, it only contains the `content` API, but future versions may include additional dashboard capabilities.

## Content Guidelines

### Character Limits

To ensure optimal display across different screen sizes and modes:

- **Main mode**: Keep content under **60 characters** to avoid truncation
- **Expanded mode**: Keep content under **250 characters** for best readability

```typescript
// Good for main mode
session.dashboard.content.writeToMain('✅ Build complete');

// Too long for main mode
session.dashboard.content.writeToMain('✅ Build completed successfully with all tests passing and no errors found');

// Good for expanded mode
session.dashboard.content.writeToExpanded(`
Build Results:
✅ Compilation: Success
✅ Tests: 47/47 passed
⏱️ Duration: 2m 34s
`);
```

### Content Replacement

The dashboard keeps only the **latest** message per app per mode. Writing a new message automatically replaces your previous one for that mode.

```typescript
// First message
session.dashboard.content.writeToMain('🔄 Starting...');

// This replaces the previous message in main mode
session.dashboard.content.writeToMain('✅ Complete!');

// But expanded mode is independent
session.dashboard.content.writeToExpanded('Detailed results...');
```

### Provide Mode-Appropriate Content

```typescript
// Good: Tailor content to the mode
const quickStatus = '✅ 5 tasks done';
const detailedStatus = `
Task Summary:
✅ Completed: 5
⏳ In progress: 2
📅 Scheduled: 3
`;

session.dashboard.content.writeToMain(quickStatus);
session.dashboard.content.writeToExpanded(detailedStatus);
```


## Message Types (Advanced)

The SDK handles these WebSocket messages automatically, but they are documented here for completeness:

| Message | `type` value | Sent By | Purpose |
| :------ | :----------- | :------ | :------ |
| `DashboardContentUpdate` | `dashboard_content_update` | TPA | Send new content to dashboard |
| `DashboardModeChange` | `dashboard_mode_change` | MentraOS | Notify of mode transitions |
| `DashboardModeQuery` | `dashboard_mode_query` | TPA | Request current mode |

These correspond to TypeScript interfaces in `@mentra/sdk/src/types/dashboard`.

## Frequently Asked Questions

### Can I send layouts or images?

Not yet. The current release supports **plain text** only. Rich layouts, images, and interactive elements are planned for future releases.

### What happens if I write multiple times in a row?

The dashboard keeps only the **latest** message per app per mode. Each new message replaces the previous one for that specific mode.

```typescript
session.dashboard.content.writeToMain('First message');
session.dashboard.content.writeToMain('Second message'); // Replaces first message
```

### Is there a character limit?

Yes, to ensure optimal display:
- **Main mode**: 60 characters maximum
- **Expanded mode**: 250 characters maximum

Content exceeding these limits may be truncated. These limits are subject to change in future releases.

### Can I detect when the user closes the dashboard?

Yes, use the `onModeChange` callback. When the dashboard is closed, the mode becomes `'none'`:

```typescript
session.dashboard.content.onModeChange((mode) => {
  if (mode === 'none') {
    console.log('User closed the dashboard');
  }
});
```
