---
title: Voice Activation Tutorial
sidebar_position: 6
---

# Voice-Activation Tutorial

Learn how to build an **MentraOS App** that:

1. Listens for live speech transcriptions provided by the system.
2. Detects a custom **activation phrase** (for example "computer").
3. Executes an action—in this guide we'll simply display a text overlay.

> Looking for a broader introduction? Start with the [Quickstart](/quickstart) guide.  This page focuses specifically on the _app code_ that handles transcriptions.

---

## Prerequisites

1. **MentraOS SDK ≥ `0.13.0`** installed in your project.
2. A local development environment configured as described in [Getting Started](/getting-started).
3. **MICROPHONE** permission added to your App in the [Developer Console](https://console.mentra.glass/) so the transcription stream is available.  See [Permissions](/permissions).

---

## 1 - Set up the Project

Create a new project—or reuse an existing one—and install the SDK:

```bash
mkdir voice-activation-app
cd voice-activation-app
bun init -y           # or npm init -y / pnpm init -y
bun add @mentra/sdk
bun add -d typescript tsx @types/node
```

Copy the basic project structure from the [Quickstart](/quickstart) if you haven't already.  We'll focus on the contents of `src/index.ts`.

---

## 2 - Write the App Code

The full source code is shown first, followed by a step-by-step explanation.

```typescript title="src/index.ts"
import { TpaServer, TpaSession } from "@mentra/sdk";

/**
 * A custom keyword that triggers our action once detected in speech
 */
const ACTIVATION_PHRASE = "computer";

/**
 * VoiceActivationServer – an App that listens for final transcriptions and
 * reacts when the user utters the ACTIVATION_PHRASE.
 */
class VoiceActivationServer extends TpaServer {
  /**
   * onSession is called automatically whenever a user connects.
   *
   * @param session   – Connection-scoped helper APIs and event emitters
   * @param sessionId – Unique identifier for this connection
   * @param userId    – MentraOS user identifier
   */
  protected async onSession(
    session: TpaSession,
    sessionId: string,
    userId: string,
  ): Promise<void> {
    session.logger.info(`🔊  Session ${sessionId} started for ${userId}`);

    // 1️⃣  Subscribe to speech transcriptions
    const unsubscribe = session.events.onTranscription((data) => {
      // 2️⃣  Ignore interim results – we only care about the final text
      if (!data.isFinal) return;

      // 3️⃣  Normalize casing & whitespace for a simple comparison
      const spokenText = data.text.toLowerCase().trim();
      session.logger.debug(`Heard: "${spokenText}"`);

      // 4️⃣  Check for the activation phrase
      if (spokenText.includes(ACTIVATION_PHRASE)) {
        session.logger.info("✨ Activation phrase detected!");

        // 5️⃣  Do something useful – here we show a text overlay
        session.layouts.showTextWall("👋 How can I help?");
      }
    });

    // 6️⃣  Clean up the listener when the session ends
    this.addCleanupHandler(unsubscribe);
  }
}

// Bootstrap the server using environment variables for configuration
new VoiceActivationServer({
  packageName: process.env.PACKAGE_NAME ?? "com.example.voiceactivation",
  apiKey: process.env.MENTRAOS_API_KEY!,
  port: Number(process.env.PORT ?? "3000"),
}).start();
```

### What Does Each Part Do?

|  #  | Code                                  | Purpose |
|:---:|:--------------------------------------|:--------|
| 1️⃣ | `session.events.onTranscription`       | Subscribes to real-time speech data.  The callback fires many times per utterance—both interim and final chunks. |
| 2️⃣ | `if (!data.isFinal) return;`           | Filters out interim chunks so we only process complete sentences. |
| 3️⃣ | `spokenText.toLowerCase().trim()`      | Normalizes the text to improve keyword matching. |
| 4️⃣ | `if (spokenText.includes(...))`        | Simple string containment check for the activation phrase. |
| 5️⃣ | `session.layouts.showTextWall(...)`    | Shows a full-screen text overlay on the glasses.  Replace with your own logic. |
| 6️⃣ | `this.addCleanupHandler(unsubscribe)`  | Ensures the transcription listener is removed when the session disconnects, preventing memory leaks. |

---

## 3 - Run the App

1. Add the required environment variables in `.env`:

   ```env
   PORT=3000
   PACKAGE_NAME=com.example.voiceactivation
   MENTRAOS_API_KEY=your_api_key_here
   ```

2. Start the development server:

   ```bash
   bun --watch src/index.ts      # auto-reload on change
   # or build & run
   bun run build && bun run start
   ```

3. Expose the port with **ngrok** (or your tunnel of choice) so MentraOS on your phone can reach it, then restart the App inside MentraOS.

---

## Best Practices

* **Keep the activation phrase natural** – Short, memorable words work best.
* **Provide user feedback** – After detecting the phrase, give immediate visual or auditory confirmation.
* **Avoid hard-coding** – Store configurable keywords in [Settings](/settings) so users can change them.
* **Review permissions** – Request only the data your App genuinely needs.  See [Permissions](/permissions#best-practices).

---

## Next Steps

* Explore more event types in the [Events](/events) reference.
* Combine voice activation with [AI Tools](/tools) to let users control your App via natural language.
* Add context-aware responses by fetching user location or calendar data—just remember to declare the corresponding permissions.