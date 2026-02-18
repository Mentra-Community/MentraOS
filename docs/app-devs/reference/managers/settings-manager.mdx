# SettingsManager API Reference

The `SettingsManager` class provides a type-safe interface for accessing and monitoring App settings. It automatically synchronizes with MentraOS Cloud and provides real-time change notifications.

## Import

```typescript
import { AppServer, AppSession } from '@mentra/sdk';

export class MyAppServer extends AppServer {
  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    // get the settings manager object
    const settingsManager = session.settings;

    // Get a specific setting value
    const language = settingsManager.get<string>('transcribe_language', 'English');

    // Listen for setting changes
    settingsManager.onValueChange('line_width', (newValue, oldValue) => {
      console.log(`Line width changed from ${oldValue} to ${newValue}`);
      this.updateDisplay(newValue);
    });
  }
}
```

## Class: SettingsManager

### Constructor

The SettingsManager is automatically instantiated by the AppSession. You should not create instances directly.

```typescript
class SettingsManager {
  constructor(
    initialSettings: AppSettings = [],
    packageName?: string,
    wsUrl?: string,
    userId?: string,
    subscribeFn?: (streams: string[]) => Promise<void>
  )
}
```

## Methods

### get

Get a setting value.

```typescript
get<T = any>(key: string, defaultValue?: T): T
```

**Parameters:**
- `key`: Setting key to retrieve
- `defaultValue`: Default value if setting doesn't exist or is undefined

**Returns:** Setting value or default value

**Example:**
```typescript
// Get with default value
const fontSize = session.settings.get<number>('font_size', 16);

// Get without default (returns undefined if not found)
const theme = session.settings.get<string>('theme');
```

### has

Check if a setting exists.

```typescript
has(key: string): boolean
```

**Parameters:**
- `key`: Setting key to check

**Returns:** True if the setting exists

**Example:**
```typescript
if (session.settings.has('advanced_mode')) {
  // Setting exists
  const enabled = session.settings.get<boolean>('advanced_mode');
}
```

### getAll

Get all settings.

```typescript
getAll(): AppSettings
```

**Returns:** Copy of all settings

**Example:**
```typescript
const allSettings = session.settings.getAll();
console.log(`Total settings: ${allSettings.length}`);

// Filter specific types
const toggles = allSettings.filter(s => s.type === 'toggle');
```

### getSetting

Find a setting by key and get the full [setting object](/reference/interfaces/setting-types#appsetting).

```typescript
getSetting(key: string): AppSetting | undefined
```

**Parameters:**
- `key`: Setting key to find

**Returns:** Setting object or undefined

**Example:**
```typescript
const setting = session.settings.getSetting('font_size');
if (setting && setting.type === 'slider') {
  console.log(`Font size: ${setting.value} (${setting.min}-${setting.max})`);
}
```

### onChange

Listen for changes to any setting.

```typescript
onChange(handler: SettingsChangeHandler): () => void
```

**Parameters:**
- `handler`: Function called when any setting changes

**Returns:** Cleanup function to remove the listener

**Example:**
```typescript
const cleanup = session.settings.onChange((changes) => {
  console.log('Settings changed:');
  for (const [key, change] of Object.entries(changes)) {
    console.log(`  ${key}: ${change.oldValue} → ${change.newValue}`);
  }
});

// Later: remove listener
cleanup();
```

### onValueChange

Listen for changes to a specific setting.

```typescript
onValueChange<T = any>(
  key: string,
  handler: SettingValueChangeHandler<T>
): () => void
```

**Parameters:**
- `key`: Setting key to monitor
- `handler`: Function called when the setting changes

**Returns:** Cleanup function to remove the listener

**Example:**
```typescript
// Type-safe value change handler
const cleanup = session.settings.onValueChange<number>(
  'font_size',
  (newSize, oldSize) => {
    console.log(`Font size changed from ${oldSize} to ${newSize}`);
    updateFontSize(newSize);
  }
);

// Multiple listeners
const cleanups = [
  session.settings.onValueChange('theme', handleThemeChange),
  session.settings.onValueChange('language', handleLanguageChange),
  session.settings.onValueChange('enable_sound', handleSoundToggle)
];

// Clean up all listeners
cleanups.forEach(cleanup => cleanup());
```

### fetch

Manually fetch settings from the cloud. This is generally not needed since settings are automatically kept in sync.

```typescript
fetch(): Promise<AppSettings>
```

**Returns:** Promise that resolves to the updated settings

**Throws:** Error if the API client is not configured or the request fails

**Example:**
```typescript
try {
  const settings = await session.settings.fetch();
  console.log('Settings refreshed:', settings);
} catch (error) {
  console.error('Failed to fetch settings:', error);
}
```

## MentraOS Settings

The SettingsManager also provides access to system-wide MentraOS settings.

### onMentraosSettingChange

Listen for changes to specific MentraOS settings.

```typescript
onMentraosSettingChange<T = any>(
  key: string,
  handler: (newValue: T, oldValue: T) => void
): () => void
```

**Parameters:**
- `key`: MentraOS setting key (e.g., 'metricSystemEnabled')
- `handler`: Function called when the value changes

**Returns:** Cleanup function to remove the listener

**Example:**
```typescript
// Listen for metric system changes
const cleanup = session.settings.onMentraosSettingChange<boolean>(
  'metricSystemEnabled',
  (enabled, wasEnabled) => {
    if (enabled) {
      console.log('Metric system enabled');
      switchToMetricUnits();
    } else {
      console.log('Metric system disabled');
      switchToImperialUnits();
    }
  }
);
```

### getMentraosSetting

Get the current value of an MentraOS setting.

```typescript
getMentraosSetting<T = any>(key: string, defaultValue?: T): T
```

**Parameters:**
- `key`: MentraOS setting key
- `defaultValue`: Default value if setting doesn't exist

**Returns:** Setting value or default value

**Example:**
```typescript
const metricEnabled = session.settings.getMentraosSetting<boolean>(
  'metricSystemEnabled',
  false
);

const userLocale = session.settings.getMentraosSetting<string>(
  'locale',
  'en-US'
);
```

## Best Practices

### 1. Provide Defaults

```typescript
// Good: Always provide a default
const lineWidth = session.settings.get<number>('line_width', 30);

// Avoid: No default can cause undefined errors
const lineWidth = session.settings.get<number>('line_width'); // Could be undefined!
```

### 2. Type Your Settings

```typescript
// Good: Use generics for type safety
const enabled = session.settings.get<boolean>('feature_enabled', false);
const theme = session.settings.get<'light' | 'dark'>('theme', 'light');

// Avoid: Using 'any' loses type safety
const value = session.settings.get('some_setting');
```

### 3. Clean Up Listeners

```typescript
import { AppServer, AppSession } from '@mentra/sdk';

export class MyAppServer extends AppServer {
  private cleanupFunctions: Array<() => void> = [];

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    // Store cleanup functions
    this.cleanupFunctions.push(
      session.settings.onValueChange('setting1', this.handler1),
      session.settings.onValueChange('setting2', this.handler2),
      session.settings.onChange(this.handleAnyChange)
    );
  }

  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    // Clean up all listeners
    this.cleanupFunctions.forEach(cleanup => cleanup());
    this.cleanupFunctions = [];
  }
}
```

## Related Documentation

* [Settings Overview](/settings) - Guide to using settings in Apps
* [Setting Types Reference](/reference/interfaces/setting-types) - Detailed type definitions
* [App Session](/reference/app-session) - AppSession class reference