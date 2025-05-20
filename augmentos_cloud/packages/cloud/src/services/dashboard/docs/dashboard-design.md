# Dashboard System Design

## Overview

The dashboard system provides contextual information to users through different view modes. It allows both system components and Third-Party Apps (TPAs) to contribute content to the dashboard, which is then displayed to the user based on the current dashboard mode.

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| SDK Dashboard Types | ✅ Complete | Basic types and interfaces for dashboard functionality |
| SDK Dashboard API | ✅ Complete | Implementation of dashboard API for TPAs |
| TpaSession Integration | ✅ Complete | Dashboard API added to TpaSession class |
| DashboardManager | ⚠️ In Progress | Core structure implemented, but needs WebSocket and Session integration |
| Dashboard Test Harness | ✅ Complete | Testing framework for validating dashboard functionality |
| Dashboard Documentation | ✅ Complete | Design, testing, and codebase documentation |
| Layout Compatibility | ✅ Complete | Updated layout generation for backward compatibility |
| WebSocket Integration | ❌ Incomplete | Need to implement TPA message handling with WebSocketService |
| DisplayManager Integration | ⚠️ In Progress | Display request structure created but lacks UserSession integration |
| Dashboard SDK Guidelines | ✅ Complete | Added best practices for using the SDK |
| Dashboard-Manager TPA | ✅ Complete | Fully reimplemented TPA using TpaServer and Dashboard API |
| SDK Type Definitions | ✅ Complete | Fixed type definitions for dashboard message types |
| System Integration | ❌ Incomplete | Need to integrate with SessionService to access user sessions |
| Individual Content TPAs | ✅ Complete | Created separate TPAs for Fun Facts, Quotes, and Gratitude |

## Dashboard Modes

The dashboard supports three primary modes:

1. **Main**: Full dashboard experience with comprehensive information
   - Displays system information in all corners
   - Shows TPA content in the center region
   - Suitable for when the user wants to see a complete dashboard

2. **Expanded**: More space for TPA content while maintaining essential info
   - Displays condensed system information in top and bottom regions
   - Provides more space for TPA content in the center
   - Useful when more detailed TPA information is needed

3. **Always-On**: Persistent minimal dashboard overlay on regular content
   - Shows minimal system information (time, battery)
   - Can display a single piece of TPA content
   - Designed to remain visible while using other TPAs
   - Uses a separate ViewType (ALWAYS_ON) for client display
   - Operates independently from main/expanded modes

## Dashboard Regions

Each dashboard mode divides the screen into different regions:

### Main Dashboard
- **topLeft**: System status, time
- **topRight**: Battery status
- **center**: TPA content area
- **bottomLeft**: Notification count
- **bottomRight**: Connection status

### Expanded Dashboard
- **top**: Condensed system information
- **center**: Larger TPA content area
- **bottom**: Condensed system status

### Always-On Dashboard
- **left**: Essential system info (time)
- **right**: Essential system info (battery)
- **tpaContent**: Minimal TPA content space

## Content Management

### System Dashboard Content
- The system dashboard TPA (system.augmentos.dashboard) controls the system sections
- It can update individual sections without affecting other parts
- Only the system dashboard TPA has permission to update system sections

### TPA Content Queue
- Each TPA can contribute content to any dashboard mode
- Content is stored in a queue for each mode
- Each TPA gets one slot in each queue
- New content from a TPA replaces its previous content
- Content is ordered by time (newest first)
- Each mode has a configurable limit on how many items to display

### Content Lifecycle
- When a TPA disconnects, its content is removed from all dashboard modes
- TPAs can target specific modes with their content
- TPAs can provide different content for different modes

## API Design

### System Dashboard API
The system dashboard has privileged access to control all dashboard aspects:

```typescript
interface DashboardSystemAPI {
  setTopLeft(content: string): void;
  setTopRight(content: string): void;
  setBottomLeft(content: string): void;
  setBottomRight(content: string): void;
  setViewMode(mode: DashboardMode): void;
}
```

### TPA Dashboard API
Regular TPAs have a more limited API focused on contributing content:

```typescript
interface DashboardContentAPI {
  write(content: string, targets?: DashboardMode[]): void;
  writeToMain(content: string): void;
  writeToExpanded(content: string): void; // Only accepts text content for expanded mode
  writeToAlwaysOn(content: string): void;
  getCurrentMode(): Promise<DashboardMode | 'none'>;
  isAlwaysOnEnabled(): Promise<boolean>;
  onModeChange(callback: (mode: DashboardMode | 'none') => void): () => void;
}
```

## Message Types

Dashboard communication uses the following message types:

### From TPAs to Cloud
- `DASHBOARD_CONTENT_UPDATE`: Regular TPAs send content to the dashboard
- `DASHBOARD_MODE_CHANGE`: System dashboard can change the current mode
- `DASHBOARD_SYSTEM_UPDATE`: System dashboard updates system sections

### From Cloud to TPAs/Glasses
- `DASHBOARD_MODE_CHANGED`: Notifies of dashboard mode changes
- `DASHBOARD_ALWAYS_ON_CHANGED`: Notifies of always-on state changes

## Integration Points

The dashboard manager integrates with:

1. **WebSocket Service**: For message handling and broadcasting updates
2. **Display Manager**: For sending dashboard layouts to the glasses (acting as a thin wrapper for display requests)
3. **TPA Session Lifecycle**: For cleaning up dashboard content when TPAs stop

> **Architectural Note**: In the new design, the cloud DashboardManager takes over all dashboard-specific logic, including content collection, layout formatting, and display request generation. The DisplayManager's role is simplified to handling the actual sending of display requests to the client without any dashboard-specific logic.

## Implementation Details

The dashboard manager maintains:

1. Content queues for each dashboard mode
2. System dashboard section content
3. Current dashboard mode and always-on state
4. Update interval for throttling display updates
5. Message handlers for dashboard-related messages

## Architectural Flow

The overall dashboard content flow follows these steps:

1. **Dashboard-Manager TPA**:
   - Collects system information (time, battery, notifications)
   - Formats system information for different sections
   - Sends system section updates to the cloud DashboardManager
   - Controls dashboard mode changes

2. **Content TPAs** (Fun Facts, Quotes, etc.):
   - Generate content relevant to their domain
   - Send content to the cloud DashboardManager
   - Can target specific dashboard modes

3. **Cloud DashboardManager**:
   - Receives system section updates from Dashboard-Manager TPA
   - Receives content from various TPAs
   - Maintains queues of content for each dashboard mode
   - Maintains separate, independent queue for always-on content
   - Formats combined layouts based on current mode
   - Processes always-on dashboard independently from main/expanded
   - Sends dashboard layouts via DisplayManager to the glasses
   - Uses different ViewType for always-on vs regular dashboard
   
4. **DisplayManager**:
   - Handles the technical aspects of sending display requests
   - No longer contains any dashboard-specific logic
   - Acts as a thin wrapper for communication with the glasses
   - Differentiates between dashboard types using the ViewType

## SDK Usage Guidelines

The AugmentOS SDK is designed to provide a simple and intuitive interface for TPA developers. Here are some key principles for how to use the SDK correctly:

### Event Subscription Model

The SDK handles all subscription management internally. Developers should:

- **Use High-Level Event Handlers**: Use methods like `onTranscription()`, `onHeadPosition()`, etc., instead of directly managing subscriptions.
- **Never Use Direct Subscribe Methods**: The `session.subscribe()` method is an internal SDK method not intended for direct use by developers.
- **Automatic Resource Management**: The SDK automatically cleans up subscriptions when handlers are removed or the session is disconnected.

```typescript
// CORRECT way to handle events:
session.onHeadPosition((data) => {
  // React to head position changes
});

// INCORRECT - don't use these internal methods directly:
// session.subscribe(StreamType.HEAD_POSITION);
```

### Dashboard API Usage

TPAs can interact with the dashboard through the appropriate API:

- **Regular TPAs**: Use `session.dashboard.content` methods to write content to the dashboard.
- **System Dashboard TPA**: Has access to `session.dashboard.system` methods to control the entire dashboard.

### Dashboard Message Handling

The SDK properly handles dashboard-related messages from the cloud:

- **Mode Changes**: When the dashboard mode changes, TPAs can be notified via the `onModeChange` handler:

```typescript
session.dashboard.content.onModeChange((mode) => {
  // Handle mode change
  console.log(`Dashboard mode changed to: ${mode}`);
});
```

- **Always-On State**: TPAs can check if the always-on mode is enabled:

```typescript
const isAlwaysOn = await session.dashboard.content.isAlwaysOnEnabled();
```

## TPA Migration Plan

### Dashboard-Manager TPA

The existing dashboard-manager TPA is outdated and needs a complete rewrite to:

1. Use the SDK's TpaSession and event handling model instead of direct WebSocket management
2. Use the Dashboard System API instead of directly creating layouts
3. Leverage the SDK's automatic subscription management instead of manual subscriptions
4. Retain the current formatting logic for system sections
5. Focus on system information (time, battery, notifications)
6. Control dashboard mode changes
7. No longer handle content generation (fun facts, quotes, etc.)

### Content TPAs

Content functionality will be moved to independent TPAs:

1. Each content type (fun facts, quotes, etc.) will become its own TPA
2. These TPAs will use the Dashboard Content API to write to the dashboard
3. Each TPA will handle its own content formatting and generation
4. Users can enable/disable individual TPAs through the app store

### Layout Compatibility

The DashboardManager will ensure backward compatibility:

1. Generate DoubleTextWall layouts for Main dashboard mode
2. Preserve the existing formatting patterns for system sections
3. Support the existing leftText/rightText model
4. Ensure proper formatting of combined TPA content