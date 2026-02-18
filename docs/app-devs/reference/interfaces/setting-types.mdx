# Setting Types Reference

This page provides detailed reference documentation for all setting-related types and interfaces in the MentraOS SDK.

## Enums

### AppSettingType

Enumeration of all available setting types.

```typescript
enum AppSettingType {
  TOGGLE = 'toggle',
  TEXT = 'text',
  SELECT = 'select',
  SLIDER = 'slider',
  GROUP = 'group',
  TEXT_NO_SAVE_BUTTON = 'text_no_save_button',
  SELECT_WITH_SEARCH = 'select_with_search',
  MULTISELECT = 'multiselect',
  TITLE_VALUE = 'titleValue'
}
```

## Interfaces

### BaseAppSetting

Base interface for all app settings.

```typescript
interface BaseAppSetting {
  /** Unique identifier for the setting */
  key: string;

  /** Human-readable label displayed to users */
  label: string;

  /** Current value selected by the user */
  value?: any;

  /** Default value if user hasn't set a preference */
  defaultValue?: any;
}
```

### Setting Type Definitions

#### ToggleSetting

Boolean on/off switch setting.

```typescript
interface ToggleSetting extends BaseAppSetting {
  type: AppSettingType.TOGGLE;
  defaultValue: boolean;
  value?: boolean;
}
```

**Example:**
```json
{
  "type": "toggle",
  "key": "enable_notifications",
  "label": "Enable Notifications",
  "defaultValue": true
}
```

#### TextSetting

Single-line text input setting.

```typescript
interface TextSetting extends BaseAppSetting {
  type: AppSettingType.TEXT;
  defaultValue?: string;
  value?: string;
}
```

**Example:**
```json
{
  "type": "text",
  "key": "user_name",
  "label": "Your Name",
  "defaultValue": "User"
}
```

#### TextNoSaveButtonSetting

Multi-line text input without save button. Updates on blur.

```typescript
interface TextNoSaveButtonSetting extends BaseAppSetting {
  type: AppSettingType.TEXT_NO_SAVE_BUTTON;
  defaultValue?: string;
  value?: string;
  /** Maximum number of visible lines */
  maxLines?: number;
}
```

**Example:**
```json
{
  "type": "text_no_save_button",
  "key": "notes",
  "label": "Personal Notes",
  "defaultValue": "",
  "maxLines": 5
}
```

#### SelectSetting

Dropdown selection from predefined options.

```typescript
interface SelectSetting extends BaseAppSetting {
  type: AppSettingType.SELECT;
  options: Array<{
    /** Display text for the option */
    label: string;
    /** Value stored when option is selected */
    value: any;
  }>;
  defaultValue?: any;
  value?: any;
}
```

**Example:**
```json
{
  "type": "select",
  "key": "theme",
  "label": "Color Theme",
  "options": [
    { "label": "Light", "value": "light" },
    { "label": "Dark", "value": "dark" },
    { "label": "Auto", "value": "auto" }
  ],
  "defaultValue": "auto"
}
```

#### SelectWithSearchSetting

Dropdown with search functionality for long option lists.

```typescript
interface SelectWithSearchSetting extends BaseAppSetting {
  type: AppSettingType.SELECT_WITH_SEARCH;
  options: Array<{
    label: string;
    value: any;
  }>;
  defaultValue?: any;
  value?: any;
}
```

**Example:**
```json
{
  "type": "select_with_search",
  "key": "country",
  "label": "Country",
  "options": [
    { "label": "United States", "value": "US" },
    { "label": "United Kingdom", "value": "UK" },
    { "label": "Canada", "value": "CA" }
    // ... many more options
  ],
  "defaultValue": "US"
}
```

#### MultiselectSetting

Multiple selection from options with checkboxes.

```typescript
interface MultiselectSetting extends BaseAppSetting {
  type: AppSettingType.MULTISELECT;
  options: Array<{
    label: string;
    value: any;
  }>;
  defaultValue?: any[];
  value?: any[];
}
```

**Example:**
```json
{
  "type": "multiselect",
  "key": "features",
  "label": "Enabled Features",
  "options": [
    { "label": "Auto-save", "value": "autosave" },
    { "label": "Spell Check", "value": "spellcheck" },
    { "label": "Dark Mode", "value": "darkmode" }
  ],
  "defaultValue": ["autosave"]
}
```

#### SliderSetting

Numeric value selection with slider control.

```typescript
interface SliderSetting extends BaseAppSetting {
  type: AppSettingType.SLIDER;
  /** Minimum allowed value */
  min: number;
  /** Maximum allowed value */
  max: number;
  defaultValue: number;
  value?: number;
}
```

**Example:**
```json
{
  "type": "slider",
  "key": "volume",
  "label": "Volume",
  "min": 0,
  "max": 100,
  "defaultValue": 50
}
```

#### GroupSetting

Visual grouping of related settings. Not a setting itself.

```typescript
interface GroupSetting {
  type: AppSettingType.GROUP;
  /** Title displayed for the group */
  title: string;
  /** Groups don't have keys */
  key?: never;
}
```

**Example:**
```json
{
  "type": "group",
  "title": "Display Settings"
}
```

#### TitleValueSetting

Read-only display of information.

```typescript
interface TitleValueSetting {
  type: AppSettingType.TITLE_VALUE;
  /** Label shown to user */
  label: string;
  /** Value to display */
  value: any;
  /** Title/value settings don't need keys */
  key?: never;
}
```

**Example:**
```json
{
  "type": "titleValue",
  "label": "App Version",
  "value": "2.1.0"
}
```

### AppSetting

Union type of all possible setting types.

```typescript
type AppSetting =
  | ToggleSetting
  | TextSetting
  | TextNoSaveButtonSetting
  | SelectSetting
  | SelectWithSearchSetting
  | MultiselectSetting
  | SliderSetting
  | GroupSetting
  | TitleValueSetting;
```

### AppSettings

Array of app settings.

```typescript
type AppSettings = AppSetting[];
```


## Setting Change Types

### SettingChange

Information about a single setting change.

```typescript
interface SettingChange {
  /** Previous value before the change */
  oldValue: any;
  /** New value after the change */
  newValue: any;
}
```

### SettingsChangeMap

Map of setting keys to their change information.

```typescript
type SettingsChangeMap = Record<string, SettingChange>;
```

## Callback Types

### SettingsChangeHandler

Callback for when any setting changes.

```typescript
type SettingsChangeHandler = (changes: SettingsChangeMap) => void;
```

### SettingValueChangeHandler

Callback for when a specific setting value changes.

```typescript
type SettingValueChangeHandler<T = any> = (
  newValue: T,
  oldValue: T
) => void;
```


## Related Documentation

* [Settings Overview](/settings) - Guide to using settings in Apps
* [Settings Manager API](/reference/managers/settings-manager) - SettingsManager class reference
* [Getting Started](/getting-started) - Complete App development guide