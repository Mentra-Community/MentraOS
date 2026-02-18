# SubscriptionManager Usage Analysis

This document analyzes how `SubscriptionManager` is used throughout the cloud codebase to understand what needs to change when we refactor to the new `AppSession` class architecture.

## Current SubscriptionManager API

### State (Private)

```typescript
private subscriptions: Map<string, Set<ExtendedStreamType>>  // packageName -> subscriptions
private history: Map<string, HistoryEntry[]>                  // packageName -> history
private lastAppReconnectAt: Map<string, number>               // packageName -> timestamp
private updateChainsByApp: Map<string, Promise<unknown>>      // packageName -> promise chain
private appsWithPCM: Set<string>                              // packageNames needing PCM
private appsWithTranscription: Set<string>                    // packageNames needing transcription
private languageStreamCounts: Map<ExtendedStreamType, number> // stream -> count
```

### Public Methods

| Method                                             | Purpose                                | Return Type                              |
| -------------------------------------------------- | -------------------------------------- | ---------------------------------------- |
| `markAppReconnected(packageName)`                  | Mark timestamp for grace window        | `void`                                   |
| `getAppSubscriptions(packageName)`                 | Get subscriptions for one app          | `ExtendedStreamType[]`                   |
| `hasSubscription(packageName, subscription)`       | Check if app has specific subscription | `boolean`                                |
| `getSubscribedApps(subscription)`                  | Get all apps subscribed to a stream    | `string[]`                               |
| `getSubscribedAppsForAugmentosSetting(settingKey)` | Get apps subscribed to system setting  | `string[]`                               |
| `getMinimalLanguageSubscriptions()`                | Get unique language streams needed     | `ExtendedStreamType[]`                   |
| `hasPCMTranscriptionSubscriptions()`               | Check if any app needs audio           | `{ hasMedia, hasPCM, hasTranscription }` |
| `updateSubscriptions(packageName, subscriptions)`  | Update app's subscriptions             | `Promise<UserI \| null>`                 |
| `removeSubscriptions(packageName)`                 | Remove all subscriptions for app       | `Promise<UserI \| null>`                 |
| `getHistory(packageName)`                          | Get subscription history for debugging | `HistoryEntry[]`                         |
| `dispose()`                                        | Clean up all state                     | `void`                                   |

---

## Usage by File

### 1. websocket-app.service.ts (App WebSocket Handler)

**Location**: `services/websocket/websocket-app.service.ts`

```typescript
// Mark reconnect for grace window
userSession.subscriptionManager.markAppReconnected(packageName)

// Handle SUBSCRIPTION_UPDATE message
await userSession.subscriptionManager.updateSubscriptions(message.packageName, message.subscriptions)

// Check if language subscriptions changed
const previousLanguageSubscriptions = userSession.subscriptionManager.getMinimalLanguageSubscriptions()
const newLanguageSubscriptions = userSession.subscriptionManager.getMinimalLanguageSubscriptions()
```

**Usage Pattern**: Write (update subscriptions), Read (check language changes)

---

### 2. websocket-glasses.service.ts (Glasses WebSocket Handler)

**Location**: `services/websocket/websocket-glasses.service.ts`

```typescript
// Relay AugmentOS settings to subscribed apps
const subscribedApps = userSession.subscriptionManager.getSubscribedAppsForAugmentosSetting(key)

// Relay gesture events to subscribed apps
const gestureSubscribers = userSession.subscriptionManager.getSubscribedApps(gestureSubscription)
const baseSubscribers = userSession.subscriptionManager.getSubscribedApps(baseSubscription)
```

**Usage Pattern**: Read (find apps to relay events to)

---

### 3. UserSession.ts

**Location**: `services/session/UserSession.ts`

```typescript
// Snapshot for client API
appSubscriptions[packageName] = this.subscriptionManager.getAppSubscriptions(packageName)
const hasPCMTranscriptionSubscriptions = this.subscriptionManager.hasPCMTranscriptionSubscriptions()
const minimumTranscriptionLanguages = this.subscriptionManager.getMinimalLanguageSubscriptions()

// Relay messages to apps
const subscribedPackageNames = this.subscriptionManager.getSubscribedApps(data.type)

// Cleanup
this.subscriptionManager.dispose()
```

**Usage Pattern**: Read (snapshot, relay), Lifecycle (dispose)

---

### 4. AppManager.ts

**Location**: `services/session/AppManager.ts`

```typescript
// When stopping an app
await this.userSession.subscriptionManager.removeSubscriptions(packageName)
```

**Usage Pattern**: Write (remove subscriptions on app stop)

---

### 5. MicrophoneManager.ts

**Location**: `services/session/MicrophoneManager.ts`

```typescript
// Check if mic should be on/off
const state = this.session.subscriptionManager.hasPCMTranscriptionSubscriptions()
```

**Usage Pattern**: Read (determine mic state based on subscriptions)

---

### 6. AudioManager.ts

**Location**: `services/session/AudioManager.ts`

```typescript
// Relay audio to subscribed apps
const subscribedPackageNames = this.userSession.subscriptionManager.getSubscribedApps(StreamType.AUDIO_CHUNK)
```

**Usage Pattern**: Read (find apps to relay audio to)

---

### 7. TranslationManager.ts

**Location**: `services/session/translation/TranslationManager.ts`

```typescript
// Relay translation data to subscribed apps
const subscribedApps = this.userSession.subscriptionManager.getSubscribedApps(subscription)
```

**Usage Pattern**: Read (find apps to relay translations to)

---

### 8. UserSettingsManager.ts

**Location**: `services/session/UserSettingsManager.ts`

```typescript
// Relay system setting changes to subscribed apps
const subscribedApps = this.userSession.subscriptionManager.getSubscribedAppsForAugmentosSetting(legacyKey)
```

**Usage Pattern**: Read (find apps to relay settings to)

---

### 9. CalendarManager.ts & LocationManager.ts

**Location**: `services/session/CalendarManager.ts`, `services/session/LocationManager.ts`

These managers receive subscription updates FROM SubscriptionManager via `syncManagers()`:

```typescript
// In SubscriptionManager.syncManagers()
this.userSession.locationManager.handleSubscriptionUpdate(locationSubs)
this.userSession.calendarManager.handleSubscriptionUpdate(calendarSubs)
```

**Usage Pattern**: Receive subscription data (not direct API calls)

---

### 10. photo-taken.service.ts

**Location**: `services/core/photo-taken.service.ts`

```typescript
// Get apps subscribed to PHOTO_TAKEN
const subscribedApps = userSession.subscriptionManager.getSubscribedApps(StreamType.PHOTO_TAKEN)
```

**Usage Pattern**: Read (find apps to send photos to)

---

### 11. hardware.routes.ts

**Location**: `routes/hardware.routes.ts`

```typescript
// Get apps subscribed to BUTTON_PRESS
const subscribedApps = userSession.subscriptionManager.getSubscribedApps(StreamType.BUTTON_PRESS)
```

**Usage Pattern**: Read (find apps to send button events to)

---

### 12. user-data.routes.ts

**Location**: `routes/user-data.routes.ts`

```typescript
// Relay custom_message to subscribed apps
const subscribedApps = userSession.subscriptionManager.getSubscribedApps(StreamType.CUSTOM_MESSAGE)
```

**Usage Pattern**: Read (find apps to relay custom messages to)

---

### 13. debug-service.ts

**Location**: `services/debug/debug-service.ts`

```typescript
// Serialize subscription state for debugging
subscriptionManager: {
  subscriptions: Object.fromEntries(session.subscriptionManager.subscriptions)
}
```

**Usage Pattern**: Read (debugging/introspection)

---

## Usage Summary

### Read Operations (Most Common)

| Method                                      | Call Sites | Purpose                                      |
| ------------------------------------------- | ---------- | -------------------------------------------- |
| `getSubscribedApps(stream)`                 | 8          | Find apps to relay events to                 |
| `getMinimalLanguageSubscriptions()`         | 2          | Determine which transcription streams needed |
| `hasPCMTranscriptionSubscriptions()`        | 2          | Determine if mic should be on                |
| `getAppSubscriptions(packageName)`          | 1          | Get subscriptions for one app                |
| `getSubscribedAppsForAugmentosSetting(key)` | 2          | Find apps for system setting relay           |

### Write Operations

| Method                           | Call Sites | Purpose                            |
| -------------------------------- | ---------- | ---------------------------------- |
| `updateSubscriptions(pkg, subs)` | 1          | Handle SUBSCRIPTION_UPDATE message |
| `removeSubscriptions(pkg)`       | 1          | Clean up when app stops            |
| `markAppReconnected(pkg)`        | 2          | Track reconnect for grace window   |

### Lifecycle

| Method      | Call Sites | Purpose                          |
| ----------- | ---------- | -------------------------------- |
| `dispose()` | 1          | Clean up on UserSession disposal |

---

## Refactoring Implications

### If Subscriptions Move to AppSession Class

The new `AppSession` class (in `AppManager.apps`) will own subscriptions per-app:

```typescript
class AppSession {
  subscriptions: Set<ExtendedStreamType>

  // Per-app methods
  getSubscriptions(): ExtendedStreamType[]
  updateSubscriptions(subs: ExtendedStreamType[]): void
  hasSubscription(stream: ExtendedStreamType): boolean
}
```

### SubscriptionManager Becomes Coordinator

SubscriptionManager can become a thin coordinator that:

1. Aggregates data across all AppSessions
2. Provides the "query" methods (getSubscribedApps, etc.)
3. Delegates per-app operations to AppSession

```typescript
class SubscriptionManager {
  // Delegates to AppManager.apps
  getSubscribedApps(stream: ExtendedStreamType): string[] {
    const result: string[] = []
    for (const [packageName, appSession] of this.userSession.appManager.apps) {
      if (appSession.hasSubscription(stream)) {
        result.push(packageName)
      }
    }
    return result
  }

  // Aggregate queries
  hasPCMTranscriptionSubscriptions(): {hasMedia; hasPCM; hasTranscription} {
    // Iterate over appManager.apps and check each
  }

  getMinimalLanguageSubscriptions(): ExtendedStreamType[] {
    // Aggregate from all appManager.apps
  }

  // Delegates to specific AppSession
  updateSubscriptions(packageName: string, subs: ExtendedStreamType[]): void {
    const appSession = this.userSession.appManager.getAppSession(packageName)
    if (appSession) {
      appSession.updateSubscriptions(subs)
    }
  }
}
```

### Alternative: Merge Into AppManager

Could also merge SubscriptionManager into AppManager entirely:

```typescript
class AppManager {
  apps: Map<packageName, AppSession>

  // Query methods that aggregate across apps
  getSubscribedApps(stream: ExtendedStreamType): string[]
  hasPCMTranscriptionSubscriptions(): {hasMedia; hasPCM; hasTranscription}
  getMinimalLanguageSubscriptions(): ExtendedStreamType[]
}
```

**Pros**: Simpler, fewer classes
**Cons**: AppManager becomes larger, might be too many responsibilities

### Recommendation

**Keep SubscriptionManager as a thin query layer** that:

- Delegates per-app operations to `AppSession`
- Provides aggregate queries across all apps
- Keeps the same public API (minimal changes to consumers)

This minimizes changes to the 15+ call sites while consolidating state into `AppSession`.

---

## Migration Checklist

### Phase 1: Create AppSession Class

- [ ] Create `AppSession` class with `subscriptions: Set<ExtendedStreamType>`
- [ ] Add per-app methods: `getSubscriptions()`, `updateSubscriptions()`, `hasSubscription()`
- [ ] Add to `AppManager.apps: Map<packageName, AppSession>`

### Phase 2: Migrate State

- [ ] Move subscription storage from `SubscriptionManager.subscriptions` to `AppSession.subscriptions`
- [ ] Update `SubscriptionManager` methods to delegate to `AppSession`
- [ ] Keep `SubscriptionManager` public API unchanged

### Phase 3: Migrate Aggregate State

- [ ] Move `appsWithPCM`, `appsWithTranscription` logic to compute from `AppSession`s
- [ ] Move `languageStreamCounts` logic to compute from `AppSession`s
- [ ] Or keep as cached aggregates updated when `AppSession` subscriptions change

### Phase 4: Test

- [ ] All 15+ call sites still work
- [ ] Subscriptions persist through reconnection
- [ ] Grace window logic still works
- [ ] Mic on/off logic still works
- [ ] Event relay to subscribed apps still works

---

## Files to Modify

| File                                      | Changes                                   |
| ----------------------------------------- | ----------------------------------------- |
| `services/session/AppSession.ts`          | NEW FILE - subscription state and methods |
| `services/session/AppManager.ts`          | Add `apps: Map<packageName, AppSession>`  |
| `services/session/SubscriptionManager.ts` | Delegate to AppSession, keep public API   |
| (All consumers)                           | No changes needed if API preserved        |
