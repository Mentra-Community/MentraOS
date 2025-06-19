# Core Concepts

This section explains the fundamental concepts you need to understand to build AugmentOS apps for smart glasses.

## 1. AugmentOS Apps

AugmentOS apps are the core of extending AugmentOS. They are *server-side* applications that you build to provide functionality to the smart glasses. Key characteristics of AugmentOS apps:

*   **Independent:** Apps run in their own process, separate from the AugmentOS Cloud and the glasses.
*   **Event-Driven:** Apps primarily interact with the system by responding to events (like transcriptions, button presses, etc.).
*   **Real-Time:** Apps communicate with the glasses via WebSockets for low-latency interaction.
*   **Server-Side:**  All app logic runs on your server, not on the glasses themselves. This allows for more complex processing and integration with external services.

## 2. Sessions

A *session* represents the active connection between a user's smart glasses and your app.

*   **Unique ID:**  Each session has a unique `sessionId` (a UUID string) assigned by AugmentOS Cloud.
*   **User Association:** A session is associated with a specific `userId`.
*   **App Association:** When a user starts your app, a new session is created specifically for that user and your app.
*   **Lifecycle:** Sessions are created when a user starts your app and are terminated when the user stops the app, the glasses disconnect, or an error occurs.

The [`TpaSession`](/reference/tpa-session) class in the SDK provides methods for interacting with a session.

## 3. WebSockets

WebSockets are the primary communication mechanism between:

*   Your app and AugmentOS Cloud.
*   AugmentOS Cloud and the smart glasses.

The SDK handles the complexities of WebSocket connections for you. You primarily interact with the [`TpaSession`](/reference/tpa-session) object, which provides methods for sending and receiving messages.

## 4. Events and Data Streams

AugmentOS Cloud sends real-time data to your app as *events*. These events represent:

*   **User Input:** [Button presses](/reference/interfaces/event-types#buttonpress), [head movements](/reference/interfaces/event-types#headposition).
*   **Sensor Data:** [Location](/reference/interfaces/event-types#locationupdate), [battery level](/reference/interfaces/event-types#glassesbatteryupdate).
*   **System Events:** Connection status, [settings changes](/reference/interfaces/config-types#appsettings).
*   **Processed Data:**  [Speech transcription](/reference/interfaces/event-types#transcriptiondata), [phone notifications](/reference/interfaces/event-types#phonenotification).

Your app *subscribes* to the events it needs.  The [`EventManager`](/reference/managers/event-manager) class (accessible through `session.events`) provides methods for subscribing to and handling events.

See the [Events](./events) section for a complete list of available events.

## 5. Permissions

AugmentOS uses a permissions system to control which device data and system resources your app can access. This system ensures user privacy and transparency while allowing you to build powerful applications with access to the data streams you need.

Your app must declare which permissions it needs to access device capabilities.

See the [Permissions](./permissions) section for detailed information about declaring and using permissions.

## 6. Layouts

Layouts control what is displayed on the smart glasses' screen.  The SDK provides several pre-defined layout types:

*   [`TextWall`](/reference/interfaces/layout-types#textwall):  Displays a single block of text.
*   [`DoubleTextWall`](/reference/interfaces/layout-types#doubletextwall):  Displays two blocks of text (top and bottom).
*   [`ReferenceCard`](/reference/interfaces/layout-types#referencecard):  Displays a card with a title and content.
*   [`BitmapView`](/reference/interfaces/layout-types#bitmapview): Displays an image on the Glasses.

You use the [`LayoutManager`](/reference/managers/layout-manager) (accessible through `session.layouts`) to display layouts.

See the [Layouts](./layouts) section for more details.

## 7. The App Lifecycle

A typical AugmentOS app lifecycle looks like this:

1.  **Webhook Request:**  When a user starts your app on their glasses, AugmentOS Cloud sends an HTTP POST request (a "webhook") to your app's pre-defined webhook URL. This request includes a unique `sessionId` and `userId`.
2.  **WebSocket Connection:**  Your app receives the webhook and uses the `sessionId` to establish a WebSocket connection to AugmentOS Cloud.
3.  **Subscription:** Your app subscribes to the events it needs (e.g., [transcription](/reference/interfaces/event-types#transcriptiondata), [head position](/reference/interfaces/event-types#headposition)).
4.  **Event Handling:**  Your app receives events from AugmentOS Cloud and processes them. This often involves updating the display using the [`LayoutManager`](/reference/managers/layout-manager).
5.  **Session Termination:** The session ends when the user stops the app, the glasses disconnect, or an error occurs.

See [App Lifecycle](./tpa-lifecycle) for a more detailed explanation.

## 8. User Authentication

AugmentOS provides mechanisms for identifying and authenticating users:

1. **Session-based identification**: Each webhook includes a `userId` that identifies the current user.
2. **Webview authentication**: If your app provides a companion web interface, and users access it through the AugmentOS manager app, you can authenticate them automatically using a token exchange system.

This allows you to provide personalized experiences and maintain user data across sessions without requiring separate login flows.

See the [Webview Authentication](/webview-auth-overview) section for more details about the webview authentication flow.

## 9. AI Tools

Your app can provide tools to the Mira AI assistant:

Your app defines tools in the [AugmentOS Developer Console](https://console.augmentos.org/tpas) under the "AI Tools" section.  When a user asks the AI to perform a task related to your app, the AI calls your tools via the `onToolCall` event.  Your app executes the requested action and returns results to the AI.

This allows users to interact with your app through natural language via the AI assistant. Tool calls don't happen in the context of a session, and your app does not need to be running to respond to a tool call.

See the [Tools](/tools) section for more details.

## 10. Settings

AugmentOS provides a comprehensive settings system that allows users to customize how your app behaves.

Settings support various types including toggles, text inputs, dropdowns, sliders, and more. This allows you to offer rich customization options without building your own settings UI.

See the [Settings](/settings) section for more details.

## 11. The AugmentOS Cloud

The AugmentOS Cloud acts as a central hub, managing:

*   User sessions.
*   App connections.
*   Data stream routing.
*   Display management.
*   Communication with external services (speech-to-text, etc).

Your app interacts with the cloud, but you don't need to worry about the internal details of how the cloud operates. The SDK abstracts away these complexities.

By understanding these core concepts, you'll be well-equipped to start building powerful and engaging apps for AugmentOS smart glasses.