# Dashboard Message Types

This document explains the dashboard message types used for communication between TPAs and the AugmentOS Cloud.

## Message Flow

The dashboard system uses a structured message flow:

1. **TPAs to Cloud**:
   - `TpaToCloudMessageType.DASHBOARD_CONTENT_UPDATE`: TPAs send content to display on the dashboard
   - `TpaToCloudMessageType.DASHBOARD_MODE_CHANGE`: System dashboard TPA changes the current mode
   - `TpaToCloudMessageType.DASHBOARD_SYSTEM_UPDATE`: System dashboard TPA updates system sections

2. **Cloud to TPAs**:
   - `CloudToTpaMessageType.DASHBOARD_MODE_CHANGED`: Notifies TPAs when dashboard mode changes
   - `CloudToTpaMessageType.DASHBOARD_ALWAYS_ON_CHANGED`: Notifies TPAs when always-on state changes

## Message Type Definitions

### TPA to Cloud Messages

```typescript
// Update dashboard content
interface DashboardContentUpdate {
  type: 'dashboard_content_update';
  packageName: string;
  content: string | Layout;
  modes: DashboardMode[];
  timestamp: Date;
}

// Change dashboard mode
interface DashboardModeChange {
  type: 'dashboard_mode_change';
  packageName: string;
  mode: DashboardMode;
  timestamp: Date;
}

// Update system section
interface DashboardSystemUpdate {
  type: 'dashboard_system_update';
  packageName: string;
  section: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';
  content: string;
  timestamp: Date;
}
```

### Cloud to TPA Messages

```typescript
// Notify when dashboard mode changes
interface DashboardModeChanged {
  type: CloudToTpaMessageType.DASHBOARD_MODE_CHANGED;
  mode: DashboardMode;
  timestamp: Date;
}

// Notify when always-on state changes
interface DashboardAlwaysOnChanged {
  type: CloudToTpaMessageType.DASHBOARD_ALWAYS_ON_CHANGED;
  enabled: boolean;
  timestamp: Date;
}
```

## Type Guards

The SDK provides type guards to safely check message types:

```typescript
// Check if a message is a dashboard mode change
function isDashboardModeChanged(message: CloudToTpaMessage): message is DashboardModeChanged {
  return message.type === CloudToTpaMessageType.DASHBOARD_MODE_CHANGED;
}

// Check if a message is an always-on state change
function isDashboardAlwaysOnChanged(message: CloudToTpaMessage): message is DashboardAlwaysOnChanged {
  return message.type === CloudToTpaMessageType.DASHBOARD_ALWAYS_ON_CHANGED;
}
```

## Best Practices

When implementing message handling:

1. **Use Type Guards**: Always use type guards to check message types, which ensures type safety.

2. **Proper Error Handling**: Wrap message handling in try/catch blocks to prevent breaking on malformed messages.

3. **Type Definitions**: Make sure all message types are properly defined and included in union types.

4. **Consistent Properties**: Include standard properties like timestamp in all messages.

## Implementation Example

```typescript
// Handling dashboard messages properly
function handleMessage(message: CloudToTpaMessage): void {
  // Using type guards for safe type checking
  if (isDashboardModeChanged(message)) {
    const mode = message.mode;
    console.log(`Dashboard mode changed to: ${mode}`);
    // Update dashboard state
  } 
  else if (isDashboardAlwaysOnChanged(message)) {
    const enabled = message.enabled;
    console.log(`Dashboard always-on mode ${enabled ? 'enabled' : 'disabled'}`);
    // Update always-on state
  }
}
```

This message type system ensures reliable and type-safe communication between TPAs and the AugmentOS Cloud.