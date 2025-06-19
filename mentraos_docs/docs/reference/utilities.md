---
sidebar_position: 8
title: Utilities
---

# Utilities

The AugmentOS SDK provides several utility classes and functions that help with resource management and working with data streams.

## ResourceTracker

[`ResourceTracker`](#resourcetracker) is a utility class used to manage the lifecycle of resources, ensuring they are properly cleaned up to prevent memory leaks.

```typescript
import { ResourceTracker, createResourceTracker } from '@augmentos/sdk';
```

### Creating a ResourceTracker

```typescript
const tracker = createResourceTracker();
```

### Properties

#### disposed

A getter that checks if the tracker has been disposed.

```typescript
get disposed(): boolean
```

**Returns:** `true` if the tracker has been disposed, `false` otherwise.

### Methods

#### track()

Registers a cleanup function to be called when the tracker is disposed.

```typescript
track(cleanup: CleanupFunction): CleanupFunction
```

**Parameters:**
- `cleanup`: A function that will be called when the tracker is disposed

**Returns:** The same cleanup function, allowing for chaining

**Example:**
```typescript
const unsubscribe = tracker.track(() => {
  console.log('Resource cleaned up');
  // Clean up code here
});

// Later, if you want to manually clean up this specific resource:
unsubscribe();
```

#### trackDisposable()

Tracks an object that has a `.dispose()` or `.close()` method.

```typescript
trackDisposable(disposable: Disposable): CleanupFunction
```

**Parameters:**
- `disposable`: An object with a `.dispose()` or `.close()` method

**Returns:** A cleanup function that will dispose or close the object when called

**Example:**
```typescript
class MyResource {
  dispose() {
    console.log('Resource disposed');
  }
}

const resource = new MyResource();
tracker.trackDisposable(resource);
```

#### trackTimer(), trackTimeout(), trackInterval()

Track Node.js timers to ensure they are cleared when the tracker is disposed.

```typescript
trackTimer(timerId: NodeJS.Timeout, isInterval?: boolean): CleanupFunction
trackTimeout(timerId: NodeJS.Timeout): CleanupFunction
trackInterval(timerId: NodeJS.Timeout): CleanupFunction
```

**Parameters:**
- `timerId`: The ID returned by `setTimeout` or `setInterval`
- `isInterval`: For `trackTimer` only - set to `true` if the timer is an interval

**Returns:** A cleanup function that will clear the timer when called

**Example:**
```typescript
const timeoutId = setTimeout(() => {
  console.log('Timeout executed');
}, 1000);

tracker.trackTimeout(timeoutId);

// Or use the convenience methods:
const intervalId = tracker.setInterval(() => {
  console.log('Interval executed');
}, 1000);
```

#### setTimeout(), setInterval()

Convenience methods that create and automatically track timers.

```typescript
setTimeout(callback: (...args: any[]) => void, ms: number): NodeJS.Timeout
setInterval(callback: (...args: any[]) => void, ms: number): NodeJS.Timeout
```

**Parameters:**
- `callback`: The function to execute
- `ms`: The time in milliseconds to wait before execution

**Returns:** The timer ID, which is already being tracked

**Example:**
```typescript
// Create and track a timeout in one step
tracker.setTimeout(() => {
  console.log('Tracked timeout executed');
}, 1000);

// Create and track an interval in one step
tracker.setInterval(() => {
  console.log('Tracked interval executed');
}, 2000);
```

#### dispose()

Executes all registered cleanup functions and marks the tracker as disposed.

```typescript
dispose(): void
```

**Example:**
```typescript
// Clean up all tracked resources
tracker.dispose();
```

### Example: Using ResourceTracker in a Resource Manager

```typescript
class ResourceManager {
  private tracker = createResourceTracker();
  
  registerListener(element: HTMLElement, event: string, handler: EventListener) {
    element.addEventListener(event, handler);
    
    // Track the cleanup
    this.tracker.track(() => {
      element.removeEventListener(event, handler);
    });
  }
  
  startPolling(callback: () => void, intervalMs: number) {
    // Creates and tracks the interval automatically
    this.tracker.setInterval(callback, intervalMs);
  }
  
  cleanup() {
    // Dispose all tracked resources at once
    this.tracker.dispose();
  }
}
```

## Stream Utility Functions

These utility functions help work with language-specific streams and stream types.

### Language Stream Types

#### ExtendedStreamType

Represents either a standard [`StreamType`](/reference/enums#streamtype) enum value or a language-specific stream string.

```typescript
type ExtendedStreamType = StreamType | string;
```

#### LanguageStreamInfo

Structure holding parsed information from a language-specific stream identifier string.

```typescript
interface LanguageStreamInfo {
  type: StreamType.TRANSCRIPTION | StreamType.TRANSLATION;
  baseType: string;
  transcribeLanguage: string;
  translateLanguage?: string;
  original: ExtendedStreamType;
}
```

### parseLanguageStream()

Parses a string to determine if it represents a language-specific stream and extracts its components.

```typescript
function parseLanguageStream(
  subscription: ExtendedStreamType
): LanguageStreamInfo | null
```

**Parameters:**
- `subscription`: The stream identifier to parse (e.g., "transcription:en-US")

**Returns:** A parsed [`LanguageStreamInfo`](#languagestreaminfo) object, or `null` if the input is not a valid language-specific stream

**Example:**
```typescript
const info = parseLanguageStream("transcription:en-US");
if (info) {
  console.log(info.type);              // StreamType.TRANSCRIPTION
  console.log(info.baseType);          // "transcription"
  console.log(info.transcribeLanguage); // "en-US"
}
```

### createTranscriptionStream()

Creates a language-specific stream identifier string for transcription.

```typescript
function createTranscriptionStream(language: string): ExtendedStreamType
```

**Parameters:**
- `language`: The language code (e.g., "en-US")

**Returns:** The formatted stream identifier string (e.g., "transcription:en-US")

**Example:**
```typescript
// Subscribe to English transcription
const streamId = createTranscriptionStream("en-US");
session.subscribe(streamId);
```

### createTranslationStream()

Creates a language-specific stream identifier string for translation.

```typescript
function createTranslationStream(
  sourceLanguage: string, 
  targetLanguage: string
): ExtendedStreamType
```

**Parameters:**
- `sourceLanguage`: The source language code (e.g., "es-ES")
- `targetLanguage`: The target language code (e.g., "en-US")

**Returns:** The formatted stream identifier string (e.g., "translation:es-ES-to-en-US")

**Example:**
```typescript
// Subscribe to Spanish-to-English translation
const streamId = createTranslationStream("es-ES", "en-US");
session.subscribe(streamId);
```

### isValidStreamType()

Checks if a value is either a valid [`StreamType`](/reference/enums#streamtype) enum member or a valid language-specific stream string.

```typescript
function isValidStreamType(subscription: ExtendedStreamType): boolean
```

**Parameters:**
- `subscription`: The value to check

**Returns:** `true` if the subscription type is valid, `false` otherwise

**Example:**
```typescript
if (isValidStreamType(StreamType.BUTTON_PRESS)) {
  // Valid standard stream type
}

if (isValidStreamType("transcription:en-US")) {
  // Valid language-specific stream
}
```

### getBaseStreamType()

Extracts the base [`StreamType`](/reference/enums#streamtype) enum value from an [`ExtendedStreamType`](#extendedstreamtype).

```typescript
function getBaseStreamType(
  subscription: ExtendedStreamType
): StreamType | null
```

**Parameters:**
- `subscription`: The [`ExtendedStreamType`](#extendedstreamtype) value

**Returns:** The base [`StreamType`](/reference/enums#streamtype), or `null` if invalid

**Example:**
```typescript
const baseType = getBaseStreamType("transcription:en-US");
// Returns StreamType.TRANSCRIPTION

const standardType = getBaseStreamType(StreamType.BUTTON_PRESS);
// Returns StreamType.BUTTON_PRESS
```

### isLanguageStream()

Checks if an [`ExtendedStreamType`](#extendedstreamtype) represents a language-specific stream.

```typescript
function isLanguageStream(subscription: ExtendedStreamType): boolean
```

**Parameters:**
- `subscription`: The [`ExtendedStreamType`](#extendedstreamtype) value

**Returns:** `true` if it's a language-specific stream format, `false` otherwise

**Example:**
```typescript
if (isLanguageStream("transcription:en-US")) {
  // Handle language-specific stream
} else {
  // Handle standard stream type
}
```

### getLanguageInfo()

Convenience function equivalent to [`parseLanguageStream()`](#parselanguagestream).

```typescript
function getLanguageInfo(
  subscription: ExtendedStreamType
): LanguageStreamInfo | null
```

**Parameters:**
- `subscription`: The [`ExtendedStreamType`](#extendedstreamtype) value

**Returns:** Parsed info or `null`

## Usage Patterns

### Managing Language-Specific Streams

```typescript
class MyTpaServer extends TpaServer {
  protected async onSession(session: TpaSession, sessionId: string, userId: string) {
    // Subscribe to English transcription
    const enTranscription = createTranscriptionStream("en-US");
    session.subscribe(enTranscription);
    
    // Subscribe to Spanish-to-English translation
    const esEnTranslation = createTranslationStream("es-ES", "en-US");
    session.subscribe(esEnTranslation);
    
    // Process the incoming streams
    session.on(StreamType.TRANSCRIPTION, (data) => {
      // Handle all transcription data
      console.log(`Transcription: ${data.text}`);
    });
    
    session.on(StreamType.TRANSLATION, (data) => {
      // Handle all translation data
      console.log(`Translation: ${data.text}`);
    });
  }
}
```

### Resource Management in TPA Sessions

```typescript
class MyTpaServer extends TpaServer {
  // Store active sessions with their resource trackers
  private activeSessions = new Map<string, ResourceTracker>();
  
  protected async onSession(session: TpaSession, sessionId: string, userId: string) {
    // Create a resource tracker for this session
    const tracker = createResourceTracker();
    this.activeSessions.set(sessionId, tracker);
    
    // Set up timers that will be automatically cleaned up
    tracker.setInterval(() => {
      // Periodic task
      console.log(`Session ${sessionId} is active`);
    }, 60000); // Every minute
    
    // Track the event handlers
    const unsubscribeBtn = session.onButtonPress((data) => {
      console.log(`Button pressed: ${data.buttonId}`);
    });
    
    // Make sure the unsubscribe function gets called when we clean up
    tracker.track(unsubscribeBtn);
  }
  
  protected async onStop(sessionId: string, userId: string, reason: string) {
    // Clean up all resources for this session
    const tracker = this.activeSessions.get(sessionId);
    if (tracker) {
      tracker.dispose();
      this.activeSessions.delete(sessionId);
    }
  }
} 