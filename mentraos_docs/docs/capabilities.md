---
sidebar_position: 10
---

# Device Capabilities

Device capabilities allow your MentraOS app to discover what hardware and software features are available on the connected smart glasses. This enables you to create adaptive experiences that work across different device models with varying capabilities.

## Overview

Different smart glasses models have different hardware configurations. Some have cameras, others don't. Some have displays, others don't. Some have speakers, others only have a microphone, or no audio support at all. The capabilities system lets you detect these differences and adapt your app accordingly.

```typescript
// Example: Check if the connected glasses have a camera
protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
  if (session.capabilities?.hasCamera) {
    // Glasses have a camera - enable photo/video features
    session.logger.info("Camera available!");
  } else {
    // No camera - show alternative features
    session.logger.info("This device supports text and voice interactions.");
  }
}
```

## Accessing Capabilities

Device capabilities are available on the [`TpaSession`](/reference/tpa-session) through the `capabilities` property:

```typescript
import { TpaSession, Capabilities } from '@mentraos/sdk';

protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
  // Capabilities may be null if not yet loaded
  const caps: Capabilities | null = session.capabilities;

  session.logger.info(`Connected to: ${caps?.modelName}`);

  // Now you can check specific capabilities
  if (caps.hasScreen) {
    session.logger.info(`Screen resolution: ${caps?.screen?.resolution?.width}x${caps?.screen?.resolution?.height}`);
  }
}
```

## Common Use Cases

### Checking for Display Capabilities

```typescript
protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
  const caps = session.capabilities;
  if (!caps) return;

  if (caps.hasScreen) {
    const screen = caps.screen!;

    // Adapt content based on screen properties
    if (screen.isColor) {
      // Use color-rich layouts and graphics
      session.layouts.showReferenceCard("🌈 Color Display", "Enjoying rich visuals!");
    } else {
      // Use high-contrast, monochrome-friendly content
      session.layouts.showTextWall("Monochrome display detected");
    }

    // Adapt text length based on screen size
    const maxLines = screen.maxTextLines || 3;
    if (maxLines < 5) {
      // Use shorter messages for smaller displays
      session.layouts.showTextWall("Short message");
    } else {
      // Can display longer content
      session.layouts.showTextWall("This is a longer message that takes advantage of larger displays with more text lines available.");
    }
  } else {
    // No screen - use audio-only interactions
    session.logger.info("No display available - using audio-only mode");
  }
}
```

### Checking for Camera Capabilities

```typescript
protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
  const caps = session.capabilities;
  if (!caps) return;

  if (caps.hasCamera) {
    const camera = caps.camera!;

    // Check video capabilities
    if (camera.video.canRecord) {
      session.logger.info("📹 Video recording available");
    }

    if (camera.video.canStream) {
      const streamTypes = camera.video.supportedStreamTypes || [];
      if (streamTypes.includes('rtmp')) {
        session.logger.info("📡 Live streaming available");
      }
    }

    // Check photo capabilities
    if (camera.resolution) {
      const megapixels = (camera.resolution.width * camera.resolution.height) / 1000000;
      session.logger.info(`📷 ${megapixels.toFixed(1)}MP camera available`);
    }
  } else {
    // No camera - disable photo/video features
    session.logger.info("Camera not available on this device");
  }
}
```


### Adaptive Feature Selection

```typescript
class AdaptiveApp extends TpaServer {
  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    const caps = session.capabilities;
    if (!caps) {
      session.layouts.showTextWall("Loading device information...");
      return;
    }

    // Create a feature matrix based on available capabilities
    const features = this.getAvailableFeatures(caps);

    // Show welcome message with available features
    const featureList = features.join('\n• ');
    session.layouts.showReferenceCard(
      `Welcome to ${caps.modelName}`,
      `Available features:\n• ${featureList}`
    );

    // Set up event subscriptions based on capabilities
    this.setupEventSubscriptions(session, caps);
  }

  private getAvailableFeatures(caps: Capabilities): string[] {
    const features: string[] = [];

    if (caps.hasCamera) {
      features.push("📷 Photo capture");
      if (caps.camera?.video.canStream) {
        features.push("📡 Live streaming");
      }
    }

    if (caps.hasMicrophone) {
      features.push("🎤 Voice commands");
      features.push("📝 Speech transcription");
    }

    if (caps.hasScreen) {
      features.push("📱 Visual interface");
      if (caps.screen?.canDisplayBitmap) {
        features.push("🖼️ Image display");
      }
    }

    if (caps.hasButton) {
      features.push("🔘 Hardware controls");
    }

    if (caps.hasWifi) {
      features.push("🌐 Internet connectivity");
    }

    return features;
  }

  private setupEventSubscriptions(session: TpaSession, caps: Capabilities): void {
    // Only subscribe to events for available hardware
    if (caps.hasMicrophone) {
      session.events.onTranscription((data) => {
        // Handle voice input
      });
    }

    if (caps.hasButton) {
      session.events.onButtonPress((data) => {
        // Handle button input
      });
    }

    if (caps.hasIMU) {
      session.events.onHeadPosition((data) => {
        // Handle head movement
      });
    }
  }
}
```


## Device Examples

For reference, here are the capabilities of some common devices:

- **Even Realities G1**: Green monochrome display, microphone, no camera
- **Vuzix Z100**: Green monochrome display, no microphone, no camera
- **Mentra Live**: No display, camera with streaming, microphone, speaker
