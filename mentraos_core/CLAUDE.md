# AugmentOS Core Development Guide

## Build Commands
- `./gradlew build` - Full project build
- `./gradlew assembleDebug` - Build debug APK
- `./gradlew test` - Run unit tests
- `./gradlew androidTest` - Run instrumentation tests

## Environment Setup
- Java SDK 17 required
- AugmentOS_Core depends on "SmartGlassesManager" repo being adjacent

## Code Style Guidelines
- Classes: PascalCase (e.g., `WebSocketManager`)
- Methods: camelCase (e.g., `isConnected()`)
- Constants: UPPER_SNAKE_CASE (e.g., `MAX_RETRY_ATTEMPTS`)
- Member variables: camelCase with m prefix (e.g., `mService`)
- Indentation: 2 spaces
- Javadoc comments for public methods and classes

## Error Handling
- Log errors with `Log.e(TAG, "Error message", e)`
- Use callbacks for asynchronous error propagation
- Handle all checked exceptions
- Provide user feedback for permissions issues

## Architecture
- Service-based design with `AugmentosService` as main component
- Fragment-based UI with Navigation Component
- EventBus for component communication
- WebSocket for server communication

## Service Consolidation Plan
- Goal: Run SmartGlassesManager functionality within AugmentosService
- Implementation approach:
  1. Keep SmartGlassesManager logic in its own class(es) 
  2. Convert SmartGlassesAndroidService from a Service to a helper class
  3. Create a SmartGlassesManager that's initialized by AugmentosService
  4. Replace "kill service" disconnect with state transitions
  5. Update all related component references
- Primary benefit: Single foreground service reduces system-managed wakelocks

## Implementation Steps
1. Create new SmartGlassesManager class that contains all logic from SmartGlassesAndroidService
   - Retain EventBus subscriptions and callbacks
   - Replace service lifecycle with initialization/cleanup methods

2. Modify AugmentosService to initialize and manage SmartGlassesManager
   - Initialize on service creation
   - Pass through commands to the manager
   - Handle events from SmartGlassesManager

3. Replace disconnectWearable() implementation
   - Instead of killing service, call cleanup/reset on SmartGlassesManager
   - Maintain state in AugmentosService
   - Update status through EventBus

4. Refactor SmartGlassesRepresentative to work with new architecture
   - Remove service dependencies
   - Work with manager class directly

5. Update client references (UI classes, callbacks) 
   - Service connection remains the same (to AugmentosService)
   - All smart glasses functionality accessed through AugmentosService APIs

## Implementation Status
The implementation has been completed, including:
- Created SmartGlassesManager class with all functionality from AugmentosSmartGlassesService
- Updated EdgeTPASystem to work with SmartGlassesManager
- Modified all methods in AugmentosService to use SmartGlassesManager
- Added helper method for notification handling
- Replaced all imports from SmartGlassesAndroidService
- Added proper event handling and event posting
- Incorporated SmartRingButtonEvent handling

Remaining tasks:
1. Test the implementation thoroughly
  - Check connection/disconnection works properly
  - Verify UI shows correctly
  - Test event handling
  - Confirm proper notification delivery
2. Address any issues with code that relies on importing from SmartGlassesAndroidService (e.g., INTENT_ACTION)
3. Remove SmartGlassesAndroidService and AugmentosSmartGlassesService classes after successful testing