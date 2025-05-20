# SDK Settings Management Design (April 9, 2025)

## Problem Statement

Currently, TPA developers need to manually implement REST API calls to fetch and update settings from the AugmentOS Cloud. This creates several issues:

1. Developers are hard-coding server URLs, making apps fragile when users are on different servers
2. Excessive boilerplate code for handling HTTP requests, authentication, and error handling
3. No easy way to react to settings changes across active sessions
4. Inconsistent behavior between WebSocket connections and REST API calls

## Solution: Integrated Settings Management

Enhance the SDK to provide a first-class settings management system that:

1. Uses the correct server URL automatically (derived from the session's WebSocket URL)
2. Loads settings automatically when a session is created 
3. Provides type-safe access to settings with default values
4. Notifies applications of settings changes
5. Automatically handles the required `/settings` endpoint

## Developer API

### Type-Safe Settings Access

```typescript
// Get settings with type safety and defaults
const lineWidth = session.settings.get<number>('line_width', 30);
const language = session.settings.get<string>('transcribe_language', 'English');
const enableFeature = session.settings.get<boolean>('enable_feature', false);

// Check if a setting exists
if (session.settings.has('custom_option')) {
  // Use the setting
}

// Get all settings at once
const allSettings = session.settings.getAll();
```

### Settings Change Notifications

```typescript
// Listen for changes to any setting
session.settings.onChange((changedSettings) => {
  // changedSettings = {
  //   'transcribe_language': { 
  //     newValue: 'French', 
  //     oldValue: 'English'
  //   },
  //   'line_width': {
  //     newValue: 40,
  //     oldValue: 30
  //   }
  // }
  
  console.log('Settings changed:', changedSettings);
  updateUIBasedOnSettings();
});

// Listen for changes to a specific setting
session.settings.onValueChange('transcribe_language', (newValue, oldValue) => {
  console.log(`Language changed from ${oldValue} to ${newValue}`);
  updateTranscriptionLanguage(newValue);
});
```

### Automatic Endpoint Registration

The SDK will automatically register the `/settings` endpoint in the TpaServer, requiring no configuration or implementation from developers:

```typescript
// Create and start the application - no manual endpoint handling needed
const app = new MyTpaApp();
app.start();
```

## Implementation Details

1. **Settings Manager:**
   - Add a `SettingsManager` class to the TpaSession
   - Cache settings in memory
   - Derive REST API URL from WebSocket URL

2. **Automatic Settings Loading:**
   - Load settings when a session is created
   - Support manual refresh if needed

3. **Settings Endpoint:**
   - Add built-in handling for the `/settings` endpoint in TpaServer
   - Validate incoming settings updates
   - Dispatch changes to all affected sessions

4. **Event System:**
   - Add settings-specific events
   - Support both general and specific change listeners
   - Provide change details including old and new values

## Example Usage

```typescript
class MyTranscriptionApp extends TpaServer {
  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    // Settings are already loaded - access with defaults
    const language = session.settings.get<string>('transcribe_language', 'English');
    const lineWidth = session.settings.get<number>('line_width', 30);
    
    // Set up initial app state based on settings
    const transcriptionStream = createTranscriptionStream(
      session.utils.languageToLocale(language)
    );
    session.subscribe(transcriptionStream);
    
    // React to settings changes
    session.settings.onValueChange('transcribe_language', (newLanguage) => {
      // Unsubscribe from old stream
      session.unsubscribe(transcriptionStream);
      
      // Subscribe to new language stream
      const newLocale = session.utils.languageToLocale(newLanguage);
      const newStream = createTranscriptionStream(newLocale);
      session.subscribe(newStream);
      
      // Update display
      session.layouts.showTextWall(`Now transcribing in ${newLanguage}`);
    });
    
    // Handle transcription events
    session.events.onTranscription((data) => {
      // Process and display transcription
    });
  }
}
```

## Benefits

1. **Reduced Code:** Eliminates ~50-100 lines of boilerplate per app
2. **Improved Reliability:** Uses correct server URL for each user
3. **Better Developer Experience:** Type-safe, event-driven API
4. **Consistency:** Same model for WebSocket and REST API interactions
5. **Future-Proof:** Abstraction shields developers from server-side changes