# Subscription System Redesign

## Current Issues

1. **Global Singleton vs Session-Specific**
   - `subscriptionService` is a singleton with global state
   - Inconsistent with other per-session managers
   - Uses composite keys (`${sessionId}:${packageName}`) for lookups

2. **Performance (n²) Problems**
   - O(n) iteration through all subscriptions for each event
   - No precomputed mappings from stream types to subscribed TPAs
   - Particularly problematic for high-frequency events (audio)

3. **Mixed Responsibilities**
   - Manages subscriptions and permission checks
   - Caches event data (calendar events, location)
   - Tracks subscription history

## Proposed Architecture

Split into two separate session-scoped managers:

1. **SubscriptionManager**: Handles subscription registration and event broadcasting
2. **CacheManager**: Manages event data caching and retrieval

## SubscriptionManager Design

```typescript
class SubscriptionManager {
  // Maps TPA to their subscriptions
  private subscriptions = new Map<string, Set<ExtendedStreamType>>();
  
  // Optimized lookup: stream type → subscribed TPAs
  private streamToApps = new Map<ExtendedStreamType, Set<string>>();
  
  // TPAs with wildcard subscriptions
  private wildcardApps = new Set<string>();
  
  // Subscription history
  private history = new Map<string, SubscriptionHistory[]>();
}
```

### Core Functionality

1. **Fast Subscription Lookup**
   - O(1) lookup of which TPAs are subscribed to an event
   - Maintain reverse mapping from stream types to TPAs
   - Special handling for wildcard subscribers

2. **Encapsulated Broadcasting**
   - Handle both subscription matching and message delivery
   - Consistent message formatting and error handling
   - Optimized for high-frequency events

3. **Subscription Lifecycle**
   - Update subscriptions with efficient map rebuilding
   - Track subscription history for debugging
   - Clean removal of subscriptions

### Key Methods

```typescript
// Update subscriptions and rebuild lookup maps
updateSubscriptions(packageName: string, subscriptions: ExtendedStreamType[]): void

// Fast O(1) lookup of subscribed apps
getSubscribedApps(streamType: ExtendedStreamType): string[]

// Broadcast event to all subscribed TPAs
broadcast(streamType: ExtendedStreamType, data: any, options?: BroadcastOptions): void

// Remove all subscriptions for a TPA
removeSubscriptions(packageName: string): void
```

## CacheManager Design

```typescript
class CacheManager {
  // Separate caches for different data types
  private calendarEventCache: CalendarEvent[] = [];
  private locationCache: Location | null = null;
  private transcriptCache: Map<string, TranscriptSegment[]> = new Map();
}
```

### Core Functionality

1. **Data Caching**
   - Store session-specific events and state
   - Manage lifecycle of cached data (expiration, cleanup)
   - Provide retrieval methods for various data types

2. **Initial State Management**
   - Supply initial state for newly connected TPAs
   - Maintain historical context for session

### Key Methods

```typescript
// Calendar events
cacheCalendarEvent(event: CalendarEvent): void
getAllCalendarEvents(): CalendarEvent[]

// Location
cacheLocation(location: Location): void
getLastLocation(): Location | null

// Transcript segments
cacheTranscriptSegment(segment: TranscriptSegment, language: string): void
getTranscriptSegments(language: string): TranscriptSegment[]

// Lifecycle
dispose(): void
```

## Integration Points

### Session Service
```typescript
// Create managers during session initialization
const userSession: ExtendedUserSession = {
  // ...
  subscriptionManager: new SubscriptionManager(partialSession as ExtendedUserSession),
  cacheManager: new CacheManager(partialSession as ExtendedUserSession),
  // ...
};
```

### WebSocket Service
```typescript
// Handle glasses message
if (isEvent(message.type)) {
  // Simply broadcast - lookup and delivery handled internally
  userSession.subscriptionManager.broadcast(message.type, message);
}

// Handle event data that needs caching
if (message.type === GlassesToCloudMessageType.CALENDAR_EVENT) {
  userSession.cacheManager.cacheCalendarEvent(message as CalendarEvent);
  userSession.subscriptionManager.broadcast(StreamType.CALENDAR_EVENT, message);
}
```

### TPA Connection
```typescript
// When TPA connects, send initial state
const calendarEvents = userSession.cacheManager.getAllCalendarEvents();
const location = userSession.cacheManager.getLastLocation();

// Format and send initial state to TPA
```

## Migration Strategy

1. Implement new managers without modifying existing code
2. Gradually migrate references from `subscriptionService` to `userSession.subscriptionManager`
3. Update WebSocket service to use new broadcast method
4. Move caching operations to `userSession.cacheManager`
5. Once migration is complete, deprecate and remove global `subscriptionService`