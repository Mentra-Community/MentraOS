# @augmentos/sdk

A TypeScript client library for building Third Party Apps (TPAs) for AugmentOS Cloud. This library provides a flexible, type-safe interface for handling WebSocket connections, managing layouts, and processing real-time data streams.

## Table of Contents

- [Introduction](#introduction)
- [Core Concepts](#core-concepts)
- [SDK Architecture](#sdk-architecture)
- [Key Features and Benefits](#key-features-and-benefits)
- [Getting Started](#getting-started)
- [Usage Guide](#usage-guide)
    - [1. Initialization](#1-initialization)
    - [2. Event Handling](#2-event-handling)
        - [Direct Methods](#direct-methods)
        - [Pub/Sub Pattern](#pubsub-pattern)
        - [Organized Events](#organized-events)
    - [3. Layout Management](#3-layout-management)
    - [4. Connection Management](#4-connection-management)
    - [5. Error Handling](#5-error-handling)
- [Available Events](#available-events)
- [Layout Types](#layout-types)
    - [TextWall](#textwall)
    - [DoubleTextWall](#doubletextwall)
    - [ReferenceCard](#referencecard)
- [Best Practices](#best-practices)
    - [1. Clean Up Subscriptions](#1-clean-up-subscriptions)
    - [2. Error Handling](#2-error-handling-1)
    - [3. Connection Management](#3-connection-management-1)
- [API Reference](#api-reference)
    - [TpaClient](#tpaclient)
        - [Constructor](#constructor)
        - [Configuration Options](#configuration-options)
        - [Methods](#methods)
    - [LayoutManager](#layoutmanager)
        - [Methods](#methods-1)
    - [EventManager](#eventmanager)
        - [Methods](#methods-2)
- [Design Overview: Types](#design-overview-types)
    - [Organization of Types](#organization-of-types)
    - [Key Type Categories](#key-type-categories)
        - [1. Message Types (./message-types.ts, ./messages/)](#1-message-types-message-types.ts-messages)
        - [2. Data Types and Models (./models.ts, ./streams.ts)](#2-data-types-and-models-models.ts-streams.ts)
        - [3. Layout Types (./layouts.ts, ./enums.ts)](#3-layout-types-layouts.ts-enums.ts)
        - [4. Enums (./enums.ts)](#4-enums-enums.ts)
    - [Benefits of TypeScript Types](#benefits-of-typescript-types)
- [Design Overview: TPA Modules](#design-overview-tpa-modules)
    - [Module Breakdown](#module-breakdown)
    - [Key Modules and Classes](#key-modules-and-classes-1)
        - [1. `TpaSession` Class (`session/index.ts`)](#1-tpaclient-class-sessionindex.ts)
        - [2. `EventManager` Class (`session/events.ts`)](#2-eventmanager-class-sessionevents.ts)
        - [3. `LayoutManager` Class (`session/layouts.ts`)](#3-layoutmanager-class-sessionlayoutsts)
        - [4. `TpaServer` Class (`server/index.ts`)](#4-tpaserver-class-serverindex.ts)
    - [Developer Workflow](#developer-workflow)
- [Contributing](#contributing)
- [License](#license)

## Introduction

Welcome to the `@augmentos/sdk` documentation. This SDK simplifies the process of building Third Party Apps (TPAs) for AugmentOS smartglasses. It provides tools for connecting to AugmentOS Cloud, handling real-time data streams, and managing user interfaces in the AR environment.

**Target Audience:** AugmentOS TPA Developers

**Purpose:** To provide a comprehensive guide for using the `@augmentos/sdk` to develop TPAs.

## Core Concepts

The `@augmentos/sdk` is built upon these core concepts:

*   **WebSocket Communication:** Establishes and manages persistent WebSocket connections with AugmentOS Cloud for real-time data exchange.
*   **Event-Driven Architecture:**  Handles asynchronous data streams and system events from AugmentOS Cloud using an event-driven model.
*   **Type Safety with TypeScript:**  Leverages TypeScript to provide strong type definitions, improving code reliability and developer experience.
*   **Layout Management:** Offers a type-safe and declarative approach to define and display UI layouts within the AR environment.
*   **Modular Design:**  Organized into logical modules for clarity, maintainability, and ease of use.

## SDK Architecture

The SDK is structured into these key directories:

*   **`src/tpa`:** Modules specifically for TPA development:
    *   **`session`:** Manages WebSocket sessions, event handling, and layout interactions (`TpaSession`, `EventManager`, `LayoutManager`).
    *   **`server`:** Provides a base class for TPA servers handling webhook events (`TpaServer`).
*   **`src/types`:**  Defines all TypeScript types, interfaces, and enums for type safety and clear data contracts.

## Key Features and Benefits

*   **Simplified WebSocket Management:** Automatic connection, reconnection, and message handling.
*   **Multiple Event Handling Patterns:**  Flexibility in event handling (direct methods, pub/sub, organized events).
*   **Type-Safe Layouts:**  Reduces UI errors with type-safe layout definitions.
*   **Comprehensive Type Definitions:**  Complete type coverage for data streams, messages, and SDK components.
*   **Easy Installation and Setup:**  Installation via `bun add @augmentos/sdk`.
*   **Well-Documented API and Design:**  Clear documentation with examples and design overviews.

## Getting Started

1.  **Installation:**

      ### bun

      ```bash
      bun add @augmentos/sdk
      ```

      ### npm
      ```bash
      npm install @augmentos/sdk
      ```

2.  **Initialization:** Instantiate `TpaClient` with your package name and API key.
    ```typescript
    import { TpaClient } from '@augmentos/sdk';

    const tpa = new TpaClient({
      packageName: 'org.example.myapp',
      apiKey: 'your_api_key'
    });
    ```

3.  **Connect to AugmentOS Cloud:** Establish a WebSocket connection.
    ```typescript
    await tpa.connect('session_123');
    ```

4.  **Handle Events:** Subscribe to data streams (e.g., transcription).
    ```typescript
    tpa.events.onTranscription((data) => {
      console.log('Transcription:', data.text);
    });
    ```

5.  **Display Layouts:** Show content on the AR display.
    ```typescript
    tpa.layouts.showTextWall('Hello AugmentOS!');
    ```

## Usage Guide

### 1. Initialization

```typescript
const tpa = new TpaClient({
  packageName: 'org.example.myapp',
  apiKey: 'your_api_key',
  serverUrl: 'ws://localhost:7002/tpa-ws', // optional, defaults to localhost cloud
  autoReconnect: true,                     // optional, defaults to false
  maxReconnectAttempts: 5,                 // optional, defaults to 0 (no limit if autoReconnect is true)
  reconnectDelay: 1000                     // optional, defaults to 1000 ms
});
```

### 2. Event Handling

The SDK provides three patterns for handling real-time events from AugmentOS Cloud.

#### Direct Methods

Type-safe, convenient methods for common events.

```typescript
// Using direct methods
const unsubscribe = tpa.onTranscription((data) => {
  console.log('Transcription:', data.text);
});

// Cleanup when done
unsubscribe();
```

#### Pub/Sub Pattern

Generic `subscribe` method for any `StreamType`.

```typescript
// Using pub/sub pattern
const unsubscribe = tpa.subscribe('transcription', (data) => {
  console.log('Transcription:', data.text);
});

// Cleanup when done
unsubscribe();
```

#### Organized Events

Type-safe event handlers available through the `events` property.

```typescript
// Using organized events interface
const unsubscribe = tpa.events.onTranscription((data) => {
  console.log('Transcription:', data.text);
});

// Cleanup when done
unsubscribe();
```

### 3. Layout Management

Use the `layouts` property for type-safe display management.

```typescript
// Text Wall - Single block of text
tpa.layouts.showTextWall(
  "Hello, World!",
  3000  // Optional duration in ms
);

// Double Text Wall - Two blocks of text
tpa.layouts.showDoubleTextWall(
  "Top text",
  "Bottom text",
  3000  // Optional duration in ms
);

// Reference Card - Title and content
tpa.layouts.showReferenceCard(
  "Title",
  "Content text",
  3000  // Optional duration in ms
);
```

### 4. Connection Management

Control and monitor the WebSocket connection.

```typescript
// Connect to AugmentOS Cloud
try {
  await tpa.connect('session_123');
  console.log('Connected!');
} catch (error) {
  console.error('Connection failed:', error);
}

// Handle connection events
tpa.events.onConnected((settings) => {
  console.log('Connected with settings:', settings);
});

tpa.events.onDisconnected(() => {
  console.log('Disconnected');
});

// Cleanup on shutdown
tpa.disconnect();
```

### 5. Error Handling

Handle errors and connection issues.

```typescript
tpa.events.onError((error) => {
  console.error('Error:', error);
});
```

## Available Events

List of real-time data streams and system events available to TPAs:

- `transcription` - Real-time speech-to-text transcription.
- `head_position` - User's head position updates (e.g., up, down).
- `button_press` - Hardware button press events (e.g., button ID, press type).
- `phone_notifications` - Phone notification events forwarded to the glasses.
- `connected` - Event emitted when a WebSocket connection is successfully established.
- `disconnected` - Event emitted when the WebSocket connection is closed or lost.
- `error` - Event for WebSocket or SDK errors.

## Layout Types

Available layout types for displaying content in AR:

#### TextWall

Simple text display for messages, status updates, notifications.

```typescript
tpa.layouts.showTextWall("Hello, World!");
```

#### DoubleTextWall

Two-section text display for comparisons, before/after content, or two-part messages.

```typescript
tpa.layouts.showDoubleTextWall(
  "Top section",
  "Bottom section"
);
```

#### ReferenceCard

Titled card with content, suitable for important information, structured data, and contextual notifications.

```typescript
tpa.layouts.showReferenceCard(
  "Title here",
  "Content here"
);
```

## Best Practices

Recommendations for writing robust and efficient TPAs.

### 1. Clean Up Subscriptions

Ensure proper cleanup of event subscriptions to prevent memory leaks and unexpected behavior.

```typescript
const cleanup = [
  tpa.onTranscription((data) => { /* ... */ }),
  tpa.events.onHeadPosition((data) => { /* ... */ }),
  tpa.subscribe('button_press', (data) => { /* ... */ })
];

// Later, when subscriptions are no longer needed
cleanup.forEach(unsubscribe => unsubscribe());
```

### 2. Error Handling

Implement comprehensive error handling, especially for WebSocket connections and event processing.

```typescript
tpa.events.onError((error) => {
  console.error('Error:', error);
  // Implement appropriate error handling logic:
  // - Display error message to user
  // - Retry connection
  // - Log error details
});
```

### 3. Connection Management

Handle connection lifecycle events and ensure graceful shutdown.

```typescript
process.on('SIGTERM', () => {
  tpa.disconnect();
  process.exit(0);
});
```

## API Reference

Detailed API documentation for key classes and interfaces.

### TpaClient

Main class for interacting with AugmentOS Cloud.

#### Constructor

```typescript
new TpaClient(config: TpaClientConfig)
```

#### Configuration Options

```typescript
interface TpaClientConfig {
  packageName: string;      // Your TPA package name (e.g., 'org.example.myapp')
  apiKey: string;          // Your API key for authentication
  serverUrl?: string;      // WebSocket server URL (optional, defaults to localhost cloud)
  autoReconnect?: boolean; // Enable automatic reconnection (optional, defaults to false)
  maxReconnectAttempts?: number; // Max reconnection attempts (optional, defaults to 0)
  reconnectDelay?: number; // Initial reconnection delay in ms (optional, defaults to 1000)
}
```

#### Methods

- `connect(sessionId: string): Promise<void>`: Establishes a WebSocket connection to AugmentOS Cloud for the given session ID. Returns a Promise that resolves on successful connection or rejects on failure.
- `disconnect(): void`: Closes the WebSocket connection gracefully.
- `onTranscription(handler: (data: TranscriptionData) => void): () => void`: Registers a handler for transcription events. Returns an unsubscribe function.
- `onHeadPosition(handler: (data: HeadPosition) => void): () => void`: Registers a handler for head position events. Returns an unsubscribe function.
- `onButtonPress(handler: (data: ButtonPress) => void): () => void`: Registers a handler for button press events. Returns an unsubscribe function.
- `onPhoneNotifications(handler: (data: PhoneNotification) => void): () => void`: Registers a handler for phone notification events. Returns an unsubscribe function.
- `subscribe<T>(type: StreamType, handler: (data: T) => void): () => void`: Generic subscribe method for any `StreamType`. Returns an unsubscribe function.
- `on(event: string, handler: (data: any) => void): () => void`:  Generic event listener for any event type. Returns an unsubscribe function.

### LayoutManager

Manages display layouts in AR. Accessible via `tpa.layouts`.

#### Methods

- `showTextWall(text: string, durationMs?: number): void`: Displays a single block of text.
- `showDoubleTextWall(topText: string, bottomText: string, durationMs?: number): void`: Displays two blocks of text.
- `showReferenceCard(title: string, text: string, durationMs?: number): void`: Displays a card with a title and content text.

### EventManager

Manages event subscriptions and emissions. Accessible via `tpa.events`.

#### Methods

- `onTranscription(handler: Handler): () => void`: Registers a handler for transcription events.
- `onHeadPosition(handler: Handler): () => void`: Registers a handler for head position events.
- `onButtonPress(handler: Handler): () => void`: Registers a handler for button press events.
- `onPhoneNotifications(handler: Handler): () => void`: Registers a handler for phone notification events.
- `onConnected(handler: Handler): () => void`: Registers a handler for connection events.
- `onDisconnected(handler: Handler): () => void`: Registers a handler for disconnection events.
- `onError(handler: Handler): () => void`: Registers a handler for error events.
- `onSettingsUpdate(handler: Handler): () => void`: Registers a handler for settings update events.
- `on<T extends StreamType>(type: T, handler: Handler<StreamDataTypes[T]>): () => void`: Generic event handler for any `StreamType`.

---

## Design Overview: Types

This section details the type system of the `@augmentos/sdk`, which uses TypeScript to provide robust interfaces and data structures for building reliable TPAs.

### Organization of Types

The `src/types` directory is structured logically:

*   **`./enums.ts`**: Enumerations like `AppState`, `LayoutType`, `StreamType`, and `TpaType`.
*   **`./message-types.ts`**: Enums for message types in different communication directions (Glasses-Cloud, Cloud-Glasses, TPA-Cloud, Cloud-TPA).
*   **`./messages/`**: Interfaces for message structures, categorized by direction:
    *   **`./messages/base.ts`**: Base `BaseMessage` interface.
    *   **`./messages/cloud-to-glasses.ts`**: Cloud to glasses messages.
    *   **`./messages/glasses-to-cloud.ts`**: Glasses to cloud messages.
    *   **`./messages/cloud-to-tpa.ts`**: Cloud to TPA messages.
    *   **`./messages/tpa-to-cloud.ts`**: TPA to cloud messages.
*   **`./layouts.ts`**: Interfaces for layout types (`TextWall`, `ReferenceCard`, `DisplayRequest`).
*   **`./streams.ts`**: `StreamType` enum and utilities for data streams.
*   **`./models.ts`**: Core data models (`AppI`, `AppSettings`, `TranscriptI`).
*   **`./user-session.ts`**: User and app session interfaces (`UserSession`, `AppSession`).
*   **`./webhooks.ts`**: Webhook request types (`SessionWebhookRequest`, `StopWebhookRequest`).
*   **`./index.ts`**: Main entry point, re-exporting all types.

### Key Type Categories

#### 1. Message Types (`./message-types.ts`, `./messages/`)

Define data structures for WebSocket and webhook communication.

*   `GlassesToCloudMessageType`, `CloudToGlassesMessageType`, `TpaToCloudMessageType`, `CloudToTpaMessageType`: Message type enums.
*   Specific Message Interfaces (e.g., `ConnectionInit`, `DisplayEvent`, `TpaConnectionAck`) in `./messages/`.

**Example: `DisplayRequest` Interface (`./layouts.ts`)**

```typescript
export interface DisplayRequest extends BaseMessage {
    type: TpaToCloudMessageType.DISPLAY_REQUEST;
    packageName: string;
    view: ViewType;
    layout: Layout;
    durationMs?: number;
}
```

#### 2. Data Types and Models (`./models.ts`, `./streams.ts`)

Represent data streams and entities in AugmentOS.

*   `StreamType` Enum (`./streams.ts`): Available data streams (e.g., `StreamType.TRANSCRIPTION`).
*   Data Stream Interfaces: Data structure for each `StreamType` (e.g., `TranscriptionData`).
*   Model Interfaces (`./models.ts`): Core entities like `AppI`, `AppSettings`, `TranscriptI`.

**Example: `TranscriptionData` Interface (`./messages/cloud-to-tpa.ts`)**

```typescript
export interface TranscriptionData extends BaseMessage {
  type: StreamType.TRANSCRIPTION;
  text: string;  // The transcribed text
  isFinal: boolean;  // Whether this is a final transcription
  transcribeLanguage?: string;  // The requested language for transcription
  startTime: number;  // Start time in milliseconds relative to session start
  endTime: number;  // End time in milliseconds relative to session start
  speakerId?: string;  // ID of the speaker if available
  duration?: number;  // Audio duration in milliseconds (usually for final)
}
```

#### 3. Layout Types (`./layouts.ts`, `./enums.ts`)

Define UI layouts for AR displays.

*   `LayoutType` Enum (`./enums.ts`): Layout types (e.g., `LayoutType.TEXT_WALL`).
*   Layout Interfaces (`./layouts.ts`): Interfaces for each `LayoutType` (e.g., `TextWall`, `ReferenceCard`).
*   `ViewType` Enum (`./enums.ts`): Target views (`ViewType.MAIN`, `ViewType.DASHBOARD`).

**Example: `ReferenceCard` Interface (`./layouts.ts`)**

```typescript
export interface ReferenceCard {
    layoutType: LayoutType.REFERENCE_CARD;
    title: string;
    text: string;
}
```

#### 4. Enums (`./enums.ts`)

Type-safe named constants for system states and options.

*   `AppState`: Application lifecycle states.
*   `TpaType`: Types of TPAs.
*   `Language`: Supported languages.
*   `ViewType`: Display view types.
*   `AppSettingType`: Types of app settings.
*   `WebhookRequestType`: Types of webhook requests.

### Benefits of TypeScript Types

*   Improved developer experience with type hints and autocompletion.
*   Early error detection during compilation.
*   Enhanced code maintainability and readability.
*   Reduced bugs due to type safety.

---

## Design Overview: TPA Modules

This section outlines the `src/tpa` directory, which contains modules for building AugmentOS TPAs.

### Module Breakdown

*   **`session/`**: Manages TPA sessions and cloud interaction:
    *   `index.ts`: `TpaSession` class.
    *   `events.ts`: `EventManager` class.
    *   `layouts.ts`: `LayoutManager` class.
*   **`server/`**: Tools for TPA servers handling webhooks:
    *   `index.ts`: `TpaServer` base class.

### Key Modules and Classes

#### 1. `TpaClient` Class (`session/index.ts`)

Main class for TPA interaction with AugmentOS Cloud.

**Responsibilities:**

*   WebSocket connection management (connect, reconnect, disconnect).
*   Authentication using API key and package name.
*   Event handling via `EventManager`.
*   Layout management via `LayoutManager`.
*   Message sending to AugmentOS Cloud.

**Usage:** See [Getting Started](#getting-started) and [Usage Guide](#usage-guide).

#### 2. `EventManager` Class (`session/events.ts`)

Handles event subscriptions and dispatching within `TpaSession`.

**Responsibilities:**

*   Manages subscriptions to `StreamType`s.
*   Registers event handlers (direct, generic `on`, specific handlers).
*   Dispatches events to registered handlers.
*   Ensures type safety for event data.

**Usage:**

```typescript
const unsubscribeTranscription = tpa.events.onTranscription((data) => {
  console.log('Transcription Data:', data);
});
```

#### 3. `LayoutManager` Class (`session/layouts.ts`)

Provides type-safe layout display methods.

**Responsibilities:**

*   Methods for layout definition (`showTextWall`, `showReferenceCard`, etc.).
*   Constructs `DisplayRequest` messages.
*   Sends messages to AugmentOS Cloud.
*   Manages layout views (`main`, `dashboard`) and durations.

**Usage:**

```typescript
tpa.layouts.showTextWall('Welcome to my TPA!', { durationMs: 5000 });
```

#### 4. `TpaServer` Class (`server/index.ts`)

Base class for TPA servers responding to webhooks.

**Responsibilities:**

*   Sets up webhook endpoint (Express.js).
*   Handles webhook requests (`onSession`, `onStop`).
*   Manages `TpaSession` instances.
*   Optional health check (`/health`) and static file serving.
*   Graceful shutdown and session cleanup.

**Usage (Extend `TpaServer` in your application):**

```typescript
import { TpaServer, TpaSession } from '@augmentos/sdk';

class MyTPAServer extends TpaServer {
  // ... override onSession and onStop ...
}
```

### Developer Workflow

1.  Choose TPA type (server-based with `TpaServer` or client-side with `TpaSession`).
2.  Instantiate `TpaSession` or extend `TpaServer`.
3.  Connect to AugmentOS Cloud using `tpa.connect(sessionId)`.
4.  Register event handlers using `tpa.events` methods.
5.  Manage layouts using `tpa.layouts` methods.
6.  Implement webhook handlers (`onSession`, `onStop`) for server-based TPAs.
7.  Run and test your TPA.

---

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

## License

MIT License. See [LICENSE](LICENSE) for details.
