# Deprecation Plan for subscription.service

This document catalogs all functions in the current subscription.service, how they're used, and how we plan to migrate them to the new system.

## Method Analysis & Migration Plan

### Core Storage

**Current Implementation:**
```typescript
private subscriptions = new Map<string, Set<ExtendedStreamType>>();
private history = new Map<string, SubscriptionHistory[]>();
private calendarEventsCache = new Map<string, CalendarEvent[]>();
private lastLocationCache = new Map<string, Location>();
```

**Usage:**
- Storage is keyed by `${sessionId}:${packageName}` composite keys
- Global state causes potential scalability and isolation issues

**Migration Plan:**
- Split into two managers:
  - `SubscriptionManager`: Session-scoped subscription tracking with `packageName` keys
  - `CacheManager`: Session-scoped data caching

---

### cacheCalendarEvent(sessionId: string, event: CalendarEvent): void

**Current Usage:**
- Called from WebSocket service when CALENDAR_EVENT messages are received
- Stores calendar events in global cache map keyed by session ID

**Dependencies:**
- WebSocket service relies on this for storing calendar events

**Migration Path:**
- Create `CacheManager.cacheCalendarEvent(event: CalendarEvent)` method
- Update WebSocket service to use `userSession.cacheManager.cacheCalendarEvent(event)`

---

### getAllCalendarEvents(sessionId: string): CalendarEvent[]

**Current Usage:**
- Called when a TPA initializes to provide historical calendar events
- Returns all cached calendar events for a specific session

**Dependencies:**
- Used during TPA initialization to provide context

**Migration Path:**
- Create `CacheManager.getAllCalendarEvents()` method
- Update initialization code to use `userSession.cacheManager.getAllCalendarEvents()`

---

### clearCalendarEvents(sessionId: string): void

**Current Usage:**
- Called during session cleanup to remove cached events
- Prevents memory leaks when sessions end

**Dependencies:**
- Session service calls this during cleanup

**Migration Path:**
- Create `CacheManager.clearCalendarEvents()` method
- Automatically call in `CacheManager.dispose()` 
- Update session cleanup to use `userSession.cacheManager.dispose()`

---

### getLastCalendarEvent(sessionId: string): CalendarEvent | undefined

**Current Usage:**
- Deprecated method still used in some places
- Returns most recent calendar event for a session

**Dependencies:**
- Legacy code may still call this

**Migration Path:**
- Create `CacheManager.getLastCalendarEvent()` that returns last item
- Mark as deprecated and encourage using `getAllCalendarEvents()`

---

### cacheLocation(sessionId: string, location: Location): void

**Current Usage:**
- Called from WebSocket service when LOCATION_UPDATE messages are received
- Stores last known location in global cache map keyed by session ID

**Dependencies:**
- WebSocket service uses this to store location updates

**Migration Path:**
- Create `CacheManager.cacheLocation(location: Location)` method
- Update WebSocket service to use `userSession.cacheManager.cacheLocation(location)`

---

### getLastLocation(sessionId: string): Location | undefined

**Current Usage:**
- Called when TPAs initialize to provide last known location
- Called during event broadcasting to determine if TPAs need location updates

**Dependencies:**
- TPA initialization code
- Location-based services

**Migration Path:**
- Create `CacheManager.getLastLocation()` method
- Update references to use `userSession.cacheManager.getLastLocation()`

---

### getKey(sessionId: string, packageName: string): string

**Current Usage:**
- Internal utility to create composite keys `${sessionId}:${packageName}`
- Used by all methods that interact with the subscription maps

**Dependencies:**
- Internal to the subscription service

**Migration Path:**
- No direct replacement needed
- SubscriptionManager will use simple packageName keys without this composite logic

---

### updateSubscriptions(sessionId: string, packageName: string, userId: string, subscriptions: ExtendedStreamType[]): Promise<void>

**Current Usage:**
- Called when a TPA sends a subscription update message
- Validates subscriptions against permissions
- Updates the subscription registry

**Dependencies:**
- WebSocket service calls this when subscription updates are received

**Migration Path:**
- Create `SubscriptionManager.updateSubscriptions(packageName, subscriptions)` 
- Refactor permission checking logic
- Update WebSocket service to use `userSession.subscriptionManager.updateSubscriptions()`

---

### hasMediaSubscriptions(sessionId: string): boolean

**Current Usage:**
- Called to determine if any TPAs need audio/media streams
- Controls microphone state on glasses

**Dependencies:**
- WebSocket service uses this to decide if audio should be processed

**Migration Path:**
- Create `SubscriptionManager.hasMediaSubscriptions()` method
- Update WebSocket service to use `userSession.subscriptionManager.hasMediaSubscriptions()`

---

### getSubscribedApps(userSession: UserSession, subscription: ExtendedStreamType): string[]

**Current Usage:**
- Called for every event to determine which TPAs should receive it
- Iterates through all subscriptions looking for matches
- Core of the broadcasting mechanism

**Dependencies:**
- WebSocket service depends on this for all event broadcasting
- Many route handlers check for subscribed apps

**Migration Path:**
- Create optimized `SubscriptionManager.getSubscribedApps(streamType)` with O(1) lookups
- Create a new `SubscriptionManager.broadcast(streamType, data)` method
- Update WebSocket service to use the new broadcast method instead

---

### getAppSubscriptions(sessionId: string, packageName: string): ExtendedStreamType[]

**Current Usage:**
- Called to get all active subscriptions for a specific TPA
- Used for debugging and status reporting

**Dependencies:**
- Debug endpoints use this
- Admin interfaces

**Migration Path:**
- Create `SubscriptionManager.getAppSubscriptions(packageName)` method
- Update references to use `userSession.subscriptionManager.getAppSubscriptions(packageName)`

---

### getSubscriptionHistory(sessionId: string, packageName: string): SubscriptionHistory[]

**Current Usage:**
- Called to retrieve subscription change history for debugging
- Tracks when subscriptions were added, updated, or removed

**Dependencies:**
- Debug endpoints
- Logging and monitoring

**Migration Path:**
- Create `SubscriptionManager.getSubscriptionHistory(packageName)` method
- Update references to use `userSession.subscriptionManager.getSubscriptionHistory(packageName)`

---

### removeSubscriptions(userSession: UserSession, packageName: string): void

**Current Usage:**
- Called when a TPA disconnects or is stopped
- Cleans up all subscriptions for that TPA

**Dependencies:**
- WebSocket service connection handlers
- Session cleanup logic

**Migration Path:**
- Create `SubscriptionManager.removeSubscriptions(packageName)` method
- Update WebSocket service to use `userSession.subscriptionManager.removeSubscriptions(packageName)`

---

### removeSessionSubscriptionHistory(sessionId: string): void

**Current Usage:**
- Called during final session cleanup
- Removes all subscription history for a session to prevent memory leaks

**Dependencies:**
- Session service cleanup logic

**Migration Path:**
- History will be automatically cleaned up when the SubscriptionManager instance is garbage collected
- Include cleanup in `SubscriptionManager.dispose()` for explicitness

---

### hasSubscription(sessionId: string, packageName: string, subscription: StreamType): boolean

**Current Usage:**
- Called to check if a specific TPA is subscribed to a specific stream type
- Used for conditional logic in various handlers

**Dependencies:**
- WebSocket service for specific event handling

**Migration Path:**
- Create `SubscriptionManager.hasSubscription(packageName, streamType)` method
- Update references to use `userSession.subscriptionManager.hasSubscription(packageName, streamType)`

---

### getMinimalLanguageSubscriptions(sessionId: string): ExtendedStreamType[]

**Current Usage:**
- Called to get the minimum set of language-specific subscriptions
- Used to determine which language models to initialize

**Dependencies:**
- Transcription service uses this to decide which languages to process

**Migration Path:**
- Create `SubscriptionManager.getMinimalLanguageSubscriptions()` method
- Update transcription service to use `userSession.subscriptionManager.getMinimalLanguageSubscriptions()`

---

### getSubscribedAppsForAugmentosSetting(userSession: UserSession, settingKey: string): string[]

**Current Usage:**
- Called to find TPAs subscribed to specific AugmentOS settings
- Part of the settings notification system

**Dependencies:**
- Settings update handlers in WebSocket service

**Migration Path:**
- Create `SubscriptionManager.getSubscribedAppsForSetting(settingKey)` method
- Update settings handlers to use `userSession.subscriptionManager.getSubscribedAppsForSetting(settingKey)`

---

## Global Functions/Properties

### isValidSubscription(subscription: ExtendedStreamType): boolean

**Current Usage:**
- Internal utility to validate subscription types
- Checks against StreamType enum and language-specific patterns

**Dependencies:**
- Internal to subscription service

**Migration Path:**
- Create `SubscriptionManager.isValidSubscription(subscription)` as private method
- Keep same validation logic but update to latest stream type definitions

---

### getSubscriptionEntries()

**Current Usage:**
- Debug utility that returns all subscription entries
- Used for monitoring and troubleshooting

**Dependencies:**
- Debug routes
- Admin interfaces

**Migration Path:**
- Create `SubscriptionManager.getDebugInfo()` method that returns relevant data
- Add session-level method to retrieve subscriptions across all sessions if needed

---

## Overall Migration Strategy

1. **New Implementation**:
   - Develop `SubscriptionManager` and `CacheManager` classes
   - Add them to the `ExtendedUserSession` interface

2. **Parallel Operation**:
   - Allow both systems to run in parallel initially
   - New code uses managers, legacy code uses subscription service

3. **Gradual Migration**:
   - Update WebSocket service first (highest impact)
   - Migrate route handlers next
   - Update utility functions last

4. **Compatibility Layer** (if needed):
   - Create adapter functions that bridge old API to new implementations
   - Example: `subscriptionService.getSubscribedApps = (userSession, subscription) => userSession.subscriptionManager.getSubscribedApps(subscription)`

5. **Validation & Testing**:
   - Implement comprehensive tests for new managers
   - Compare outputs between old and new implementations
   - Validate performance improvements

6. **Deprecation Timeline**:
   - Mark subscription service methods as `@deprecated` with migration notes
   - Set concrete timeline for removal (e.g., 2-3 sprints)
   - Remove dependencies in priority order