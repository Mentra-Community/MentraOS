# Display Guidelines for AugmentOS TPAs

## Overview

This guide provides best practices and technical guidelines for showing content on AugmentOS smart glasses from your Third-Party Application (TPA). The display system has specific constraints and behaviors that must be understood for the best user experience.

## Smart Glasses Display Constraints

AugmentOS smart glasses have significant hardware constraints that affect how content is displayed:

- **Single Color**: All text appears in green (no color options)
- **Text Only**: Only plain text can be displayed (no images or rich styling)
- **Bandwidth Limited**: Bluetooth connection has limited bandwidth
- **Throttled Updates**: 200-300ms minimum delay between display updates
- **No Confirmation**: No way to confirm if displays were received/rendered

## Display Manager System

AugmentOS Cloud uses a DisplayManager to coordinate what's shown on the glasses. It handles:

1. **Throttling**: Ensures displays don't exceed hardware limits
2. **Priority**: Determines which TPA's content is shown when multiple TPAs want to display
3. **Background Locks**: Manages which TPAs can display in the background
4. **Boot Screens**: Shows loading screens during app startup

## Layout Types

AugmentOS supports several layout types, each optimized for specific use cases:

### TextWall

A simple block of text. Best for:
- Simple status messages
- Transcription display
- Short notifications

```typescript
layout: {
  layoutType: LayoutType.TEXT_WALL,
  text: "Your message here"
}
```

### ReferenceCard

A titled card with content. Best for:
- Important information with context
- Information that needs a title
- Structured data presentation

```typescript
layout: {
  layoutType: LayoutType.REFERENCE_CARD,
  title: "Title Here",
  text: "Your content here"
}
```

### DoubleTextWall

Two sections of text, one above the other. Best for:
- Before/after comparisons
- Original/translated text
- Question/answer pairs

```typescript
layout: {
  layoutType: LayoutType.DOUBLE_TEXT_WALL,
  topText: "Top section text",
  bottomText: "Bottom section text"
}
```

### DashboardCard

A key-value style display. Best for:
- Dashboard widgets
- Status indicators
- Metric displays

```typescript
layout: {
  layoutType: LayoutType.DASHBOARD_CARD,
  leftText: "Temperature",
  rightText: "72°F"
}
```

## Display Request Best Practices

### Timing Considerations

1. **Respect Throttling**: The system enforces a minimum 200ms delay between updates.
   - Your requests might be queued if sent too quickly
   - Send fewer, more meaningful updates rather than rapid small changes

2. **Duration Management**:
   - For temporary displays, use the `durationMs` parameter
   - Only short-lived content should have a duration
   - Critical information should not have a duration (will stay until replaced)

```typescript
// A temporary notification that will clear after 3 seconds
session.layouts.showTextWall("Message sent!", { durationMs: 3000 });
```

### Display Priority

1. **Core Apps vs Background Apps**:
   - Core system apps (like LiveCaptions) have priority
   - Your TPA may need to acquire a "background lock" to display
   - Background locks expire after inactivity

2. **When Your Display Won't Show**:
   - During boot phase of any app
   - When another app has priority
   - When updates are being throttled
   - When the WebSocket connection is unstable

### Content Optimization

1. **Text Length**:
   - Keep text concise (glasses have limited field of view)
   - Break long content into meaningful chunks
   - Consider user reading speed (~200 WPM)

2. **Visual Structure**:
   - Use newlines to create visual separation
   - Use special characters for emphasis (e.g., *, -, =)
   - Choose the right layout type for your content

3. **Information Hierarchy**:
   - Most important information first
   - Group related information
   - Use consistent patterns that users can learn

## Technical Implementation

### Sending Display Requests

Use the SDK's layouts API to send display requests:

```typescript
// Simple text display
session.layouts.showTextWall("Hello, world!");

// Reference card with title
session.layouts.showReferenceCard("Weather", "Sunny and 75°F");

// Double text wall for comparison
session.layouts.showDoubleTextWall(
  "Original: Hello",
  "Translated: Bonjour"
);

// Dashboard card for metrics
session.layouts.showDashboardCard("CPU", "32%");
```

### View Types

AugmentOS supports two view types:

1. **Main View (`ViewType.MAIN`)**:
   - Primary display area
   - Used for most content
   - Default if not specified

2. **Dashboard (`ViewType.DASHBOARD`)**:
   - Secondary display seen when user looks up
   - Used for persistent information and widgets
   - Not throttled like main view

```typescript
// Show in dashboard view
session.layouts.showDashboardCard("Time", "3:42 PM", { 
  view: ViewType.DASHBOARD 
});
```

### Error Handling

Since there's no confirmation that displays were received:

1. **Design Defensively**: Make your UI work even if some updates are missed
2. **Redundancy**: For critical information, send it multiple times
3. **Self-Contained**: Each update should make sense on its own
4. **Stateless Design**: Don't rely on specific display sequences

## Debugging Tips

1. **Check Logs**: The server logs display requests and their status
2. **Use Metrics**: Track display success rates and failures
3. **Test Timing**: Verify your app works with the 200ms throttling
4. **Try Different Loads**: Test with multiple TPAs active simultaneously

## Common Pitfalls

1. **Sending Too Many Updates**: Overwhelming the system with rapid changes
2. **Expecting Immediate Display**: Not accounting for throttling
3. **Not Handling Priority**: Assuming your display will always show
4. **Too Much Content**: Sending text that's too long or complex
5. **Relying on Color/Format**: Trying to use formatting that isn't supported

## Best Practices Summary

1. **Be Concise**: Keep text short and focused
2. **Be Patient**: Respect the throttling system
3. **Be Resilient**: Design for missing updates
4. **Be Consistent**: Use persistent patterns for predictability
5. **Be Considerate**: Remember your app shares display with others