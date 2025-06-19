---
sidebar_position: 1
title: Configuration Types
---

# Configuration Types

This page documents the interfaces and types used for configuring TPAs in the AugmentOS SDK.

## TpaConfig

Represents the structure of the `tpa_config.json` file, defining metadata and settings for a TPA.

```typescript
interface TpaConfig {
  /** The human-readable name of the TPA. */
  name: string;
  
  /** A brief description of the TPA's functionality. */
  description: string;
  
  /** The version string of the TPA. */
  version: string;
  
  /** An array defining the configurable settings for the TPA. */
  settings: (AppSetting | GroupSetting)[];
}
```

**Example:**
```typescript
const tpaConfig: TpaConfig = {
  name: "Weather App",
  description: "Displays real-time weather information for your current location",
  version: "1.0.0",
  settings: [
    {
      type: "group",
      title: "General Settings"
    },
    {
      key: "useCelsius",
      type: AppSettingType.TOGGLE,
      label: "Use Celsius",
      defaultValue: false
    },
    {
      key: "updateFrequency",
      type: AppSettingType.SELECT,
      label: "Update Frequency",
      defaultValue: "hourly",
      options: [
        { label: "Hourly", value: "hourly" },
        { label: "Every 3 hours", value: "3hours" },
        { label: "Daily", value: "daily" }
      ]
    }
  ]
};
```

## AppSetting

Union type representing a specific, configurable application setting. Used in [`TpaConfig`](#tpaconfig) and [`AppSettings`](#appsettings).

```typescript
type AppSetting =
  | (BaseAppSetting & { 
      type: AppSettingType.TOGGLE; 
      defaultValue: boolean; 
      value?: boolean 
    })
  | (BaseAppSetting & { 
      type: AppSettingType.TEXT; 
      defaultValue?: string; 
      value?: string 
    })
  | (BaseAppSetting & {
      type: AppSettingType.SELECT;
      options: { label: string; value: any }[]; 
      defaultValue?: any;
      value?: any;
    });

interface BaseAppSetting {
  /** The unique identifier for this setting (used programmatically). */
  key: string;
  
  /** The human-readable label displayed in the settings UI. */
  label: string;
  
  /** The current value set by the user (provided by the cloud at runtime). */
  value?: any;
  
  /** The default value for this setting if the user hasn't set one. */
  defaultValue?: any;
}
```

The [`AppSettingType`](/reference/enums#appsettingtype) enum defines the available types of settings:
- [`AppSettingType.TOGGLE`](/reference/enums#appsettingtype) - A boolean toggle/switch
- [`AppSettingType.TEXT`](/reference/enums#appsettingtype) - A text input field
- [`AppSettingType.SELECT`](/reference/enums#appsettingtype) - A dropdown selection

### Toggle Setting Example

```typescript
const toggleSetting: AppSetting = {
  key: "enableNotifications",
  type: AppSettingType.TOGGLE,
  label: "Enable Notifications",
  defaultValue: true,
  value: true
};
```

### Text Setting Example

```typescript
const textSetting: AppSetting = {
  key: "username",
  type: AppSettingType.TEXT,
  label: "Username",
  defaultValue: ""
};
```

### Select Setting Example

```typescript
const selectSetting: AppSetting = {
  key: "theme",
  type: AppSettingType.SELECT,
  label: "Theme",
  options: [
    { label: "Light", value: "light" },
    { label: "Dark", value: "dark" },
    { label: "System Default", value: "system" }
  ],
  defaultValue: "system"
};
```

## GroupSetting

A pseudo-setting used in [`TpaConfig`](#tpaconfig) to group related settings visually in the UI. It doesn't hold a value.

```typescript
interface GroupSetting {
  /** Must be 'group'. */
  type: 'group';
  
  /** The title displayed for the group header in the settings UI. */
  title: string;
}
```

**Example:**
```typescript
const groupSetting: GroupSetting = {
  type: "group",
  title: "Display Preferences"
};
```

## AppSettings

An array of [`AppSetting`](#appsetting) objects, representing the complete set of settings for a TPA instance, including current user values.

```typescript
type AppSettings = AppSetting[];
```

**Example:**
```typescript
const settings: AppSettings = [
  {
    key: "enableNotifications",
    type: AppSettingType.TOGGLE,
    label: "Enable Notifications",
    defaultValue: true,
    value: false // User has changed from default
  },
  {
    key: "refreshInterval",
    type: AppSettingType.SELECT,
    label: "Refresh Interval",
    options: [
      { label: "1 minute", value: 60 },
      { label: "5 minutes", value: 300 },
      { label: "15 minutes", value: 900 }
    ],
    defaultValue: 300,
    value: 60 // User has selected 1 minute
  }
];
```

## Working with Settings

### Accessing Setting Values

To access a specific setting's value:

```typescript
// Using TpaSession.getSetting()
const enableNotifications = tpaSession.getSetting<boolean>("enableNotifications");
if (enableNotifications) {
  // Notifications are enabled
}

// Using TpaSession.getSettings() with manual lookup
const allSettings = tpaSession.getSettings();
const refreshInterval = allSettings.find(s => s.key === "refreshInterval")?.value;
```

The [`getSetting()`](/reference/tpa-session#getsetting) and [`getSettings()`](/reference/tpa-session#getsettings) methods are available on the [`TpaSession`](/reference/tpa-session) class.

### Reacting to Setting Changes

```typescript
// Listen for changes to all settings
tpaSession.events.onSettingsUpdate((settings) => {
  // Handle updated settings
  console.log("Settings updated:", settings);
});

// Listen for changes to a specific setting
tpaSession.events.onSettingChange<number>("refreshInterval", (newValue, oldValue) => {
  console.log(`Refresh interval changed from ${oldValue} to ${newValue}`);
  // Update refresh logic based on new interval
});
```

The [`onSettingsUpdate()`](/reference/managers/event-manager#onsettingsupdate) and [`onSettingChange()`](/reference/managers/event-manager#onsettingchange) methods are available on the [`EventManager`](/reference/managers/event-manager) class, accessed via `tpaSession.events`.

### Automatic Subscription Management Based on Settings

```typescript
tpaSession.setSubscriptionSettings({
  // Update subscriptions when these settings change
  updateOnChange: ["enableTranscription", "enableHeadTracking"],
  
  // Determine active subscriptions based on current settings
  handler: (settings) => {
    const subscriptions: StreamType[] = [];
    
    // Find settings by key
    const enableTranscription = settings.find(s => s.key === "enableTranscription")?.value === true;
    const enableHeadTracking = settings.find(s => s.key === "enableHeadTracking")?.value === true;
    
    // Add subscriptions based on settings
    if (enableTranscription) {
      subscriptions.push(StreamType.TRANSCRIPTION);
    }
    
    if (enableHeadTracking) {
      subscriptions.push(StreamType.HEAD_POSITION);
    }
    
    return subscriptions;
  }
});
```

The [`setSubscriptionSettings()`](/reference/tpa-session#setsubscriptionsettings) method is available on the [`TpaSession`](/reference/tpa-session) class. It allows automatic management of [`StreamType`](/reference/enums#streamtype) subscriptions based on setting changes.