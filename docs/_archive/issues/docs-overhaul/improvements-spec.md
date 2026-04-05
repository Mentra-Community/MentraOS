# Documentation Improvements Spec

**Created:** November 6, 2024  
**Status:** Phase 1 Complete ✅  
**Priority:** Medium - Enhances learning experience

---

## Overview

This document tracks planned improvements to the MentraOS documentation based on user feedback and identified gaps.

## Decisions Made

1. **Local Development** - Add minimal section to existing overview.mdx, not a new page
2. **CRUD References** - Remove all CRUD mentions from mira-tool-calls-advanced.mdx (irrelevant terminology)
3. **Location Module** - Reference actual SDK LocationManager class from location.ts
4. **Mira Display Control** - Document how to prevent Mira from auto-displaying responses (check SDK for current implementation)

---

## 1. Add Local Development Section to Deployment

### Location

`docs/app-devs/getting-started/deployment/overview.mdx`

### Problem

Developers testing locally don't understand how to expose their local server to MentraOS Cloud. The existing deployment overview jumps straight to production.

### Solution

Add a **minimal** "Local Development" section to the existing `overview.mdx` - don't create a new page.

### Proposed Addition (Keep it Brief)

Add this section BEFORE "## Deployment Options":

````markdown
## Local Development

Testing locally? Use **ngrok** to expose your local server to MentraOS Cloud:

```bash
# Install ngrok
brew install ngrok  # or download from ngrok.com

# Start your app
npm start  # runs on localhost:3000

# Create tunnel
ngrok http 3000
```
````

Copy the ngrok URL (e.g., `https://abc123.ngrok.io`) and set it as your "App Server URL" in the [Developer Console](https://console.mentra.glass/apps).

<Warning>
Free ngrok URLs change each restart. For persistent URLs, deploy to Railway or Ubuntu.
</Warning>
```

### Rationale

- **Minimal addition** - Just the essential steps
- **Actionable** - Developers can start immediately
- **Links to deployment** - Natural flow to production options

---

## 2. Rewrite Mira Tool Calls Cookbook as Realistic Example

### Location

`docs/cookbook/mira-tool-calls-advanced.mdx`

### Problem

Current cookbook is too generic with poor example descriptions that Mira can't understand when/how to use the tools. Vague patterns like "create_item" don't teach developers proper tool design.

### Solution

**Replace generic CRUD patterns with a complete, realistic example app.** The cookbook should show:

1. **A real use case** - Something practical developers can learn from
2. **Properly described tools** - Clear descriptions that help Mira understand when to call them
3. **Complete implementation** - From tool definition to handler code
4. **Best practices** - What makes good tool descriptions vs bad ones
5. **Three core MentraOS features** - Mira Tool Calls, Simple Storage, Dashboard API

**Proposed Example: "Dashboard Note App"**

Build a simple app that lets users save ONE short note to their dashboard (visible when they look up):

**Tools:**

- `save_note` - "Save a short note to display on the dashboard"
- `read_note` - "Read the current note from the dashboard"
- `clear_note` - "Clear the note from the dashboard"

**Features demonstrated:**

- ✅ **Mira Tool Calls** - Voice commands to save/read/clear note
- ✅ **Simple Storage** - Persist the note using `session.settings.set()`
- ✅ **Dashboard API** - Display note in bottom-right when user looks up
- ✅ **Clear tool descriptions** - Help Mira understand when to call each tool
- ✅ **Complete implementation** - Full working code, no external dependencies

**Why this example:**

- **Simple but useful** - One note is easier to understand than complex reminder system
- **Uses MentraOS features** - Not fake databases or external APIs
- **Teaches 3 core concepts** - Tool calls, storage, dashboard in one example
- **Practical** - Users actually want quick notes visible when they look up

**Implementation Outline:**

```typescript
class DashboardNoteApp extends AppServer {
  protected async onSession(session: AppSession, sessionId: string, userId: string) {
    // Load saved note and display on dashboard
    const savedNote = await session.simpleStorage.get("dashboard_note")
    if (savedNote) {
      session.dashboard.content.writeToMain(savedNote)
    }
  }

  protected async onToolCall(toolCall: ToolCall): Promise<string | undefined> {
    const session = this.getSessionByUserId(toolCall.userId)

    if (toolCall.toolId === "save_note") {
      const note = toolCall.toolParameters.note as string

      // Save to Simple Storage
      await session.simpleStorage.set("dashboard_note", note)

      // Display on dashboard
      session.dashboard.content.writeToMain(note)

      // Return context for Mira
      return `Note saved: "${note}"`
    }

    if (toolCall.toolId === "read_note") {
      const note = await session.simpleStorage.get("dashboard_note")
      return note ? `Your note says: "${note}"` : "You don't have a note saved"
    }

    if (toolCall.toolId === "clear_note") {
      await session.simpleStorage.delete("dashboard_note")
      session.dashboard.content.writeToMain("")
      return "Note cleared"
    }
  }
}
```

**Tool Definitions (in Developer Console):**

```json
{
  "id": "save_note",
  "description": "Save a short note to display on the user's dashboard. The note will be visible when they look up at their glasses.",
  "parameters": {
    "note": {
      "type": "string",
      "description": "The note content to save (keep it short for dashboard display)",
      "required": true
    }
  }
}
```

**What the cookbook will teach:**

1. How to define tools with clear descriptions Mira understands
2. How to use Simple Storage to persist data (`session.simpleStorage.get()`, `set()`, `delete()`)
3. How to write to the dashboard (bottom-right display)
4. How tool responses provide context for Mira
5. Good vs bad tool descriptions (with examples)

### Rationale

- **No fake dependencies** - Uses built-in Simple Storage instead of mocked database
- **Multiple feature integration** - Shows how to combine different MentraOS APIs
- **Copy-paste ready** - Developers can adapt this to their needs
- **Shows best practices** - Tool descriptions are crucial for Mira understanding
- **Matches cookbook purpose** - Longer, more detailed guide to keep core concepts short

---

## 3. Add Location to Core Concepts

### Current State

Location is referenced in the codebase but doesn't have a dedicated page in Core Concepts.

### Location Manager Reference Exists

`docs/app-devs/reference/managers/location-manager.mdx` exists but isn't linked from Core Concepts.

### Proposed Solution

#### Add Location to Core Concepts Navigation

**New file:** `docs/app-devs/core-concepts/location.mdx`

**Must reference the actual SDK LocationManager class from `location.ts`:**

**Content structure:**

````markdown
---
title: Location
description: Access user's GPS location from smart glasses
icon: location-dot
---

Access the user's GPS coordinates to build location-aware apps on MentraOS using the `LocationManager`.

## Quick Start

### Subscribe to Location Stream

```typescript
protected async onSession(session: AppSession, sessionId: string, userId: string) {
  // Subscribe to continuous location updates
  const unsubscribe = session.location.subscribeToStream(
    { accuracy: "standard" },
    (data) => {
      const { latitude, longitude, accuracy } = data;

      session.layouts.showTextWall(
        `Lat: ${latitude.toFixed(4)}\n` +
        `Lon: ${longitude.toFixed(4)}\n` +
        `Accuracy: ${accuracy}m`
      );
    }
  );

  // Cleanup when done
  // unsubscribe();
}
```
````

### Get Latest Location (One-Time Poll)

```typescript
protected async onSession(session: AppSession, sessionId: string, userId: string) {
  try {
    const location = await session.location.getLatestLocation({
      accuracy: "high"
    });

    session.layouts.showTextWall(`Location: ${location.latitude}, ${location.longitude}`);
  } catch (error) {
    session.logger.error("Failed to get location:", error);
  }
}
```

## LocationManager API

The SDK provides `session.location` (LocationManager) with:

### `subscribeToStream(options, handler)`

Subscribe to continuous location updates.

**Accuracy options:**

- `"standard"` - Default accuracy
- `"high"` - High accuracy GPS
- `"realtime"` - Real-time updates
- `"tenMeters"` - ~10m accuracy
- `"hundredMeters"` - ~100m accuracy
- `"kilometer"` - ~1km accuracy
- `"threeKilometers"` - ~3km accuracy
- `"reduced"` - Battery-saving mode

**Returns:** Cleanup function to unsubscribe

### `unsubscribeFromStream()`

Unsubscribe from the location stream.

### `getLatestLocation(options)`

One-time location poll. Returns a Promise that resolves with LocationUpdate.

**Timeout:** 15 seconds

## Location Data Structure

```typescript
interface LocationUpdate {
  latitude: number // Decimal degrees
  longitude: number // Decimal degrees
  accuracy: number // Meters
  altitude?: number // Meters above sea level
  timestamp: Date // When location was captured
  correlationId?: string // For tracking poll requests
}
```

## Common Use Cases

### Show Nearby Places

```typescript
const unsubscribe = session.location.subscribeToStream({accuracy: "high"}, async (data) => {
  const {latitude, longitude} = data
  const places = await fetchNearbyPlaces(latitude, longitude)
  session.layouts.showTextWall(places.join("\n"))
})
```

### Location-Based Reminders

```typescript
session.location.subscribeToStream({accuracy: "hundredMeters"}, (data) => {
  const distance = calculateDistance(data, targetLocation)
  if (distance < 100) {
    // Within 100m
    session.audio.speak("You're near your reminder location!")
  }
})
```

## Permissions

Location access requires the `location` permission in your app manifest.

## Best Practices

- **Choose appropriate accuracy** - Higher accuracy = more battery drain
- **Unsubscribe when done** - Call cleanup function to stop updates
- **Handle poll timeouts** - `getLatestLocation()` times out after 15s
- **Cache location** - Updates may be infrequent depending on accuracy tier
- **Respect privacy** - Only request location if your app needs it

## Next Steps

<CardGroup cols={2}>
  <Card title="Location Manager" icon="book" href="/app-devs/reference/managers/location-manager">
    Complete API reference
  </Card>
  <Card title="Permissions" icon="lock" href="/app-devs/core-concepts/permissions">
    Learn about permissions
  </Card>
</CardGroup>
```

#### Add to docs.json Navigation

Insert after "LED Control" and before "Hardware & Capabilities":

```json
"app-devs/core-concepts/location",
```

### Icon Choice

Use `location-dot` (FontAwesome) to match the theme

---

## 4. Add Practical Cookbook Examples

### Current State

Only one cookbook entry: `mira-tool-calls-advanced.mdx`

### Problem

Developers learn best from complete, practical examples that match common use cases seen in Discord support channels.

### Proposed Cookbook Additions

#### Priority 1: Camera + LLM Example (HIGH DEMAND)

**File:** `docs/cookbook/camera-llm-vision.mdx`

**Title:** "Take a Picture and Describe It with AI"

**Content:**

- Use camera to take photo
- Send image to OpenAI Vision API
- Speak the description back to user
- Complete working code example
- Error handling
- Rate limiting considerations

**Why:** Most requested feature in Discord. Showcases camera, audio, and external API integration.

---

#### Priority 2: Live Captions

**File:** `docs/cookbook/live-captions.mdx`

**Title:** "Display Live Captions from Microphone"

**Content:**

- Listen to speech-to-text events
- Display interim and final transcriptions
- Show on dashboard vs layouts
- Handle long captions (truncation)
- Clear captions when done

**Why:** Simple but powerful example. Shows real-time updates.

---

#### Priority 3: Dashboard Widgets (Choose One)

**Option A: Weather Dashboard**

**File:** `docs/cookbook/weather-dashboard.mdx`

**Title:** "Show Weather on Dashboard"

**Content:**

- Fetch weather from API (OpenWeather)
- Display on dashboard (persistent)
- Update periodically
- Location-based weather

**Option B: Random Jokes**

**File:** `docs/cookbook/joke-dashboard.mdx`

**Title:** "Random Jokes on Dashboard"

**Content:**

- Fetch joke from API
- Display on dashboard
- Refresh on button press or voice command
- Simpler API, no location needed

**Why:** Shows dashboard usage, API calls, and persistent UI. Good for beginners.

**Recommendation:** Start with Weather (more practical) but Jokes is easier to implement.

---

#### Priority 4: Settings Page Example

**File:** `docs/cookbook/app-with-settings.mdx`

**Title:** "Build an App with a Settings Page"

**Content:**

- Use Simple Storage for settings
- Build settings UI (webview or layout-based)
- Load settings on app start
- Update settings from voice commands
- Example: Theme preference, notification settings, etc.

**Why:** Common question. Shows Simple Storage + UI patterns.

---

### Implementation Order

1. **Camera + LLM** (Priority 1 - Start here)
2. **Live Captions** (Priority 2 - Quick win)
3. Choose ONE:
   - **Weather Dashboard** (more useful) OR
   - **Joke Dashboard** (easier)
4. **Settings Page** (if time allows)

### Cookbook Structure

Each cookbook should follow this template:

```markdown
---
title: [Clear, Action-Oriented Title]
description: [One-line description of what you'll build]
icon: [relevant icon]
---

## What You'll Build

[2-3 sentences describing the end result]

## Prerequisites

- Basic understanding of [relevant concepts]
- [Any API keys needed]
- [Packages to install]

## Full Code

<Accordion title="View Complete Code">
[Full working example - copy-paste ready]
</Accordion>

## Step-by-Step Breakdown

### Step 1: [First Major Step]

[Explanation + code snippet]

### Step 2: [Second Major Step]

[Explanation + code snippet]

[etc.]

## Testing

1. [How to test locally]
2. [What to expect]
3. [Common issues]

## Next Steps

<CardGroup cols={2}>
  [Related docs]
</CardGroup>
```

---

## Summary of Changes

| Change                                       | Priority | Effort   | Impact                          |
| -------------------------------------------- | -------- | -------- | ------------------------------- |
| Add Local Development (ngrok) - MINIMAL      | HIGH     | VERY LOW | HIGH - Helps beginners          |
| Rewrite Mira cookbook with realistic example | HIGH     | MEDIUM   | HIGH - Shows proper tool design |
| Add Location to Core Concepts                | MEDIUM   | MEDIUM   | MEDIUM - Fills gap              |
| Document Mira display control                | HIGH     | LOW      | HIGH - Critical understanding   |
| Camera + LLM Cookbook                        | HIGH     | MEDIUM   | HIGH - Most requested           |
| Live Captions Cookbook                       | MEDIUM   | LOW      | MEDIUM - Shows real-time        |
| Weather/Joke Dashboard                       | LOW      | LOW      | LOW - Nice to have              |
| Settings Page Cookbook                       | LOW      | MEDIUM   | MEDIUM - Common question        |

---

## Implementation Plan

### Phase 1: Quick Wins (High Impact, Low Effort) ✅ COMPLETE

1. ✅ Created comprehensive Local Development page with ngrok guide
2. ✅ Created Dashboard Note cookbook (Mira + Simple Storage + Dashboard)
3. ✅ Documented Mira display control (context vs manual control)
4. ✅ Added Location to Core Concepts (data dictionaries, no fake examples)
5. ⏳ Add Camera + LLM cookbook (Phase 2)

### Phase 2: Fill Gaps (Medium Priority)

6. ⏳ Add Camera + LLM cookbook
7. ⏳ Add Live Captions cookbook

### Phase 3: Polish (Lower Priority)

8. ⏳ Add Weather or Joke Dashboard cookbook
9. ⏳ Add Settings Page cookbook

---

## Notes

- **Keep additions minimal** - Don't overwrite existing pages, just add essentials
- **Make cookbooks realistic** - Use complete, practical examples not generic patterns
- **Reference actual SDK** - Location docs must use LocationManager from location.ts
- **Keep examples complete** - Each cookbook should be copy-paste ready
- **Test all code examples** - Examples must work with current SDK version
- **Use real APIs** - OpenAI, OpenWeather, etc. (document API key setup)
- **Explain Mira context vs control** - Developers must understand returned strings are context for Mira

---

## Completed Items

1. ✅ **Local Development** - DONE: Created dedicated page with architecture explanation, ngrok setup, troubleshooting
2. ✅ **Dashboard Note cookbook** - DONE: Complete realistic example (512 lines) with Mira, Simple Storage, Dashboard
3. ✅ **Location SDK** - DONE: Added to Core Concepts using actual LocationManager, data dictionaries, removed fake examples
4. ✅ **Mira display control** - DONE: Documented context vs `GIVE_APP_CONTROL_OF_TOOL_RESPONSE` pattern
5. ⏳ **Phase 2** - Camera + LLM cookbook, Live Captions

## What Was Built

### 1. Local Development Page (NEW)

**File:** `docs/app-devs/getting-started/deployment/local-development.mdx`

- Explains MentraOS architecture (Cloud → App Server)
- Why tunneling is needed (localhost not accessible)
- Complete ngrok setup guide
- Development workflow
- ngrok web interface (localhost:4040)
- Troubleshooting common issues
- Alternatives (CloudFlare Tunnel, localtunnel)
- Security considerations
- When to use local dev vs deployment
- **310 lines** of comprehensive documentation

### 2. Dashboard Note Cookbook (NEW)

**File:** `docs/cookbook/dashboard-note-app.mdx`

- Complete working app showing 3 core features
- Mira Tool Calls with proper descriptions
- Simple Storage API (`session.simpleStorage`)
- Dashboard API (`session.dashboard.content.writeToMain`)
- Explains context vs control patterns
- Tool response behavior
- Common issues and solutions
- Extension examples
- **512 lines** of comprehensive documentation

### 3. Mira Display Control Documentation

**File:** `docs/cookbook/mira-tool-calls-advanced.mdx`

- Added "Controlling Tool Responses" section
- Default behavior (context for Mira)
- Taking control with `GIVE_APP_CONTROL_OF_TOOL_RESPONSE`
- When to use each approach
- Examples of both patterns
- **~100 lines** added

### 4. Location Page (NEW - Slimmed)

**File:** `docs/app-devs/core-concepts/location.mdx`

- Uses actual SDK LocationManager
- Method documentation table
- Accuracy tiers table with battery impact
- LocationUpdate data structure table
- Simple usage examples (no fake APIs)
- Best practices
- Error handling patterns
- **240 lines** (removed 125 lines of fake examples)

### 5. Navigation Updates

**File:** `docs/docs.json`

- Added `local-development` to Deployment section
- Added `location` to Core Concepts

### 6. Deployment Overview Update

**File:** `docs/app-devs/getting-started/deployment/overview.mdx`

- Links to new local-development page
- Shows all three options: Local, Railway, Ubuntu

## Mira Display Control

### How Tool Call Responses Work

**By default:** What you return from `onToolCall()` is **context for Mira**, not what displays on glasses.

```typescript
protected async onToolCall(toolCall: ToolCall): Promise<string | undefined> {
  if (toolCall.toolId === "add_reminder") {
    const title = toolCall.toolParameters.title as string;

    // Save reminder to database
    await db.reminders.create({ userId, title });

    // This is context FOR MIRA, not what user sees
    return `Reminder "${title}" was successfully saved to the database with ID 123`;
  }
}
```

**What happens:**

1. Your app returns context about what happened
2. Mira uses this context to formulate a natural response
3. Mira displays: "I've added that reminder for you" (or similar)

### Taking Control of Display

If you **don't want Mira to respond** and want to control the display yourself:

```typescript
import { AppServer, GIVE_APP_CONTROL_OF_TOOL_RESPONSE } from '@mentra/sdk';

protected async onToolCall(toolCall: ToolCall): Promise<string | undefined> {
  if (toolCall.toolId === "add_reminder") {
    const title = toolCall.toolParameters.title as string;
    const session = this.getSessionByUserId(toolCall.userId);

    // Save reminder
    await db.reminders.create({ userId, title });

    // You handle the display
    session.layouts.showTextWall(`✅ Reminder added:\n${title}`);

    // Return this constant to prevent Mira from also responding
    return GIVE_APP_CONTROL_OF_TOOL_RESPONSE;
  }
}
```

### When to Use Each Approach

| Approach                                       | When to Use                           | Example                                                                 |
| ---------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| **Return context (default)**                   | Let Mira handle natural responses     | "Reminder saved with ID 123" → Mira: "Got it, I've added that reminder" |
| **Return `GIVE_APP_CONTROL_OF_TOOL_RESPONSE`** | You want precise control over display | Show custom UI, formatted data, or skip response entirely               |

**Best practice:** Let Mira handle responses unless you need specific formatting or custom UI.

### Documentation Location

Add section "Controlling Tool Responses" to `mira-tool-calls-advanced.mdx` explaining:

1. Default behavior (context → Mira → natural response)
2. Taking control with `GIVE_APP_CONTROL_OF_TOOL_RESPONSE`
3. When to use each approach
4. Examples of both patterns

---

## Success Metrics

- ✅ "How do I test locally?" comprehensively answered
- ✅ Developers understand tunneling and ngrok
- ✅ Clear examples of Mira Tool Calls with proper descriptions
- ✅ Simple Storage, Dashboard, Location APIs documented with data dictionaries
- ✅ Context vs control pattern for Mira responses explained
- ⏳ Camera + LLM cookbook (Phase 2)
- ⏳ Live Captions cookbook (Phase 2)

## Files Created/Modified

**Created:**

1. `docs/app-devs/getting-started/deployment/local-development.mdx` (310 lines)
2. `docs/cookbook/dashboard-note-app.mdx` (512 lines)
3. `docs/app-devs/core-concepts/location.mdx` (240 lines)

**Modified:** 4. `docs/app-devs/getting-started/deployment/overview.mdx` (simplified) 5. `docs/cookbook/mira-tool-calls-advanced.mdx` (added display control section) 6. `docs/docs.json` (navigation updates)

**Total:** 1,062+ lines of new documentation, all using verified SDK APIs
