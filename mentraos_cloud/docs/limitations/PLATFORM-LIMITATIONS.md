# AugmentOS Platform Limitations

**Author:** Isaiah Ballah (github: isaiahb)  
**Date:** March 25, 2025  
**Version:** 1.0  

## 1. Overview

This document outlines the key limitations and constraints of the AugmentOS platform that TPA developers need to understand. These limitations stem primarily from the hardware capabilities of the smart glasses, the architecture of the AugmentOS Cloud, and design decisions made to maximize performance and battery life. Understanding these limitations will help you design TPAs that work effectively within the platform's constraints.

## 2. Display and UI Limitations

### 2.1 Limited Layout Options

The SDK only supports a fixed set of layout types:

- `TextWall`: A simple block of text
- `DoubleTextWall`: Two sections of text, one above the other
- `ReferenceCard`: A card with a title and text content
- `DashboardCard`: A left-right layout for key-value pairs
- `BitmapView`: For displaying images

There is no support for:
- Custom layout positioning
- Advanced layout composition
- Multiple elements in a single layout
- Animation or transitions

```typescript
// Example of available layout options
session.layouts.showTextWall("Simple text content");
session.layouts.showReferenceCard("Title", "Content text");
```

### 2.2 Text Formatting Constraints

Text must be manually formatted by TPAs before sending to display:

- Text must be wrapped at appropriate lengths (typically 30-35 characters per line for English)
- Chinese/Japanese characters require different wrapping (approximately 10-12 characters)
- No support for text styles (bold, italic, etc.)
- No support for colors or highlighting
- No support for different fonts or sizes

```typescript
// Example of manual text wrapping
import { wrapText } from '@augmentos/utils';
const wrappedText = wrapText("Long text that needs to be wrapped", 30);
session.layouts.showTextWall(wrappedText);
```

### 2.3 Display Duration and Timing

Content display has significant timing constraints:

- TPAs must specify a `durationMs` for how long content should display
- Content automatically disappears after the specified duration
- Typical durations range from 3-20 seconds
- No persistent displays (everything is temporary)
- The display manager enforces a minimum delay (typically 200-400ms) between display updates to prevent UI flickering

```typescript
// Showing content with a specific duration
session.layouts.showTextWall("This will appear for 5 seconds", {
  durationMs: 5000
});
```

## 3. Hardware Integration Limitations

### 3.1 Input Constraints

Limited input capabilities:

- No direct user input via touch or buttons on the glasses
- Voice commands with associated transcription latency
- Head position tracking (with limited precision)
- No user gestures or eye tracking
- No direct keyboard/pointer input from glasses

### 3.2 Audio Processing Limitations

Audio handling constraints:

- VAD (Voice Activity Detection) has latency and can trigger falsely
- Audio is transmitted as binary LC3-encoded chunks that require decoding
- Limited ability to process continuous audio streams
- No built-in audio mixing or effects
- Some language detection limitations with non-English languages

```typescript
// Audio handling requires careful implementation
session.events.onAudioChunk((chunk) => {
  // Complex binary ArrayBuffer handling required
});
```

### 3.3 Power and Resource Constraints

Smart glasses have limited resources:

- Battery life concerns limit processing capabilities
- Network bandwidth constraints
- Limited memory for caching or storage
- Processing power limitations affect real-time capabilities
- Heat generation concerns with intensive processing

## 4. Communication and Network Limitations

### 4.1 WebSocket Communication Constraints

WebSocket-based communication has inherent limitations:

- Connection drops require manual handling
- Message sizes should be kept small
- Binary data requires special handling
- No automatic reconnection (must be implemented)
- Network latency affects real-time experiences

### 4.2 Subscription Model Constraints

The event subscription model has limitations:

- TPAs must explicitly subscribe to every stream type they need
- Subscriptions are coarse-grained (entire stream types)
- Language-specific streams require special handling
- No fine-grained control over data volume
- Subscribing to high-volume streams (like audio) can overload TPAs

```typescript
// Example of subscription handling
const subMessage: TpaSubscriptionUpdate = {
  type: TpaToCloudMessageType.SUBSCRIPTION_UPDATE,
  packageName: "com.example.myapp",
  sessionId,
  subscriptions: [StreamType.TRANSCRIPTION, StreamType.HEAD_POSITION]
};
ws.send(JSON.stringify(subMessage));
```

## 5. Session and State Management Limitations

### 5.1 Session Persistence Limitations

Limited persistence capabilities:

- Session state is primarily in-memory
- No built-in persistent storage for TPA data
- Session reconstruction after disconnection is limited
- Background app state can be lost
- No cross-session persistence without external storage

### 5.2 Display Contention

Multiple TPAs compete for display space:

- Only one TPA can display content at a time (shared display)
- System apps (e.g., transcription) have display priority
- Display requests can be overridden by higher-priority content
- No concept of UI layers or compositing
- No split-screen or multi-app view

```typescript
// Example of forced display (will only work in certain cases)
const displayRequest: DisplayRequest = {
  type: TpaToCloudMessageType.DISPLAY_REQUEST,
  view: ViewType.MAIN,
  packageName: "com.example.myapp",
  sessionId,
  layout: {
    layoutType: LayoutType.TEXT_WALL,
    text: "Important message"
  },
  forceDisplay: true  // May not always work depending on priorities
};
ws.send(JSON.stringify(displayRequest));
```

## 6. Developer Experience Limitations

### 6.1 Resource Management Requirements

Current SDK requires manual resource management:

- Event handler cleanup must be handled manually
- Timer cleanup must be handled manually
- Memory management is developer's responsibility
- Resource leaks are easy to create accidentally
- No automatic garbage collection for some resources

```typescript
// Example of manual cleanup required
const cleanup = session.events.onTranscription((data) => {
  // Handle transcription
});

// Must remember to call cleanup later
cleanup(); // If you forget this, resource leak occurs
```

### 6.2 Error Handling Complexity

Error handling is complex:

- WebSocket error handling requires careful implementation
- No standardized error recovery patterns
- Many edge cases must be handled manually
- Limited visibility into error states
- No built-in retry mechanisms

## 7. Common Patterns and Workarounds

Despite these limitations, TPAs can work effectively by following these patterns:

### 7.1 Text Display Patterns

```typescript
// Break up long text into multiple displays
function showLongMessage(session, longText) {
  const chunks = splitIntoChunks(longText, 200); // Split by character count
  
  // Show chunks sequentially with increasing durations
  chunks.forEach((chunk, index) => {
    const wrappedText = wrapText(chunk, 30);
    setTimeout(() => {
      session.layouts.showTextWall(wrappedText, {
        durationMs: 5000 + (index * 1000) // Longer duration for later chunks
      });
    }, index * 6000); // Staggered display
  });
}
```

### 7.2 Debouncing and Throttling

```typescript
// Debouncing pattern for frequent updates (e.g., transcription)
function debounceDisplay(sessionId, text) {
  const debounceDelay = 400; // ms
  
  // Clear previous timer
  if (displayTimers[sessionId]) {
    clearTimeout(displayTimers[sessionId]);
  }
  
  // Set new timer
  displayTimers[sessionId] = setTimeout(() => {
    session.layouts.showTextWall(text);
    displayTimers[sessionId] = null;
  }, debounceDelay);
}
```

### 7.3 Robust Connection Management

```typescript
// Connection management pattern
ws.on('close', () => {
  console.log(`Session ${sessionId} disconnected`);
  // Clean up all resources
  clearAllTimers();
  removeAllListeners();
  
  // Attempt reconnection if appropriate
  if (shouldReconnect) {
    setTimeout(() => {
      attemptReconnect(sessionId, userId);
    }, reconnectDelay);
  }
});
```

## 8. Future Roadmap

While these limitations currently exist, the AugmentOS platform is actively evolving. Future updates may address:

1. **Improved Layout System**: More flexible layouts and composition
2. **Automatic Resource Management**: Eliminating manual cleanup requirements
3. **Enhanced Session Persistence**: Better state recovery after disconnections
4. **Input Enhancements**: More input options and gesture recognition
5. **Multi-App Display**: Ability for multiple TPAs to share display space
6. **Improved Developer Tools**: Better debugging and monitoring

## 9. Conclusion

Building effective TPAs for AugmentOS requires understanding these limitations and designing accordingly. Focus on simple, clear user experiences that work within the platform constraints rather than trying to overcome them. By embracing these limitations as design parameters, you can create TPAs that provide valuable functionality while offering a consistent, reliable experience for users.

Remember that many of these limitations exist to protect battery life, ensure performance, and provide a consistent user experience across different glasses hardware. Working within these constraints rather than against them will lead to the most successful TPAs.