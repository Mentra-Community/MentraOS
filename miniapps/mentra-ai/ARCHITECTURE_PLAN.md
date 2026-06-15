# Mentra AI - Architecture & Implementation Plan

> **Status:** Implementation Complete
> **Base:** New-Mentra-AI (Camera Example App)
> **SDK Version:** `@mentra/sdk` 3.0.0-hono.4
> **Date:** February 2026

---

## Executive Summary

This document outlines the architecture for rebuilding Mentra AI as a clean, focused smart glasses AI assistant. We're starting from the Camera Example App template and porting the good parts of the current Mentra AI while eliminating the dead code, broken features, and architectural mess.

### What We're Building
- Voice-first AI assistant activated by "Hey Mentra"
- Vision-capable (analyzes what user sees via glasses camera)
- Web search, calculator, and reasoning tools
- Context-aware (location, weather, time, notifications)
- Conversation history stored in MongoDB

### What We're NOT Building (Removed from Scope)
- TPA/App control (SmartAppControl, TpaCommandsTool, etc.)
- Follow-up mode (5-second wake-word-free window)
- Personality system (just default for now)
- Complex disambiguation logic
- Cancellation phrases ("never mind", "cancel", etc.)
- LocationIQ integration (using Google Maps only)

---

## Tech Stack

| Component | Old | New |
|-----------|-----|-----|
| Runtime | Bun | Bun |
| Backend Framework | Express | **Hono** (via @mentra/sdk) |
| Frontend | React 19 + Vite + Tailwind | React 19 + Bun + Tailwind |
| Agent Framework | LangChain (ReAct) | **Mastra** |
| LLM | Multi-provider (Claude, GPT, Gemini) | **Gemini 2.5 Flash** (primary) |
| Vision | Google Gemini | Google Gemini |
| Database | MongoDB + Mongoose | MongoDB + Mongoose |
| Real-time | SSE + WebSocket | SSE |
| Deployment | Docker | Docker |

---

## Folder Structure

```
New-Mentra-AI/
├── src/
│   ├── index.ts                    # Entry point (Bun + Hono)
│   │
│   ├── server/
│   │   ├── MentraAI.ts             # Main app class (extends AppServer)
│   │   │
│   │   ├── agent/
│   │   │   ├── MentraAgent.ts      # Mastra agent definition
│   │   │   ├── prompt.ts           # System prompt builder (ported from unifiedPrompt.ts)
│   │   │   └── tools/
│   │   │       ├── index.ts        # Tool exports
│   │   │       ├── search.tool.ts  # Web search (Jina API)
│   │   │       ├── calculator.tool.ts
│   │   │       └── thinking.tool.ts
│   │   │
│   │   ├── manager/
│   │   │   ├── SessionManager.ts   # User session map (from template)
│   │   │   ├── TranscriptionManager.ts  # Wake word + speech handling
│   │   │   ├── QueryProcessor.ts   # Main query pipeline
│   │   │   ├── PhotoManager.ts     # Camera capture (from template)
│   │   │   ├── AudioManager.ts     # TTS (from template)
│   │   │   ├── LocationManager.ts  # GPS + geocoding + weather
│   │   │   ├── NotificationManager.ts  # Phone notification context
│   │   │   └── ChatHistoryManager.ts   # MongoDB conversation storage
│   │   │
│   │   ├── session/
│   │   │   └── User.ts             # Per-user state container
│   │   │
│   │   ├── routes/
│   │   │   └── routes.ts           # API route definitions
│   │   │
│   │   ├── api/
│   │   │   ├── health.ts
│   │   │   ├── stream.ts           # SSE endpoints
│   │   │   ├── chat.ts             # Debug chat endpoint
│   │   │   └── history.ts          # Conversation history API
│   │   │
│   │   ├── db/
│   │   │   ├── connection.ts       # MongoDB connection
│   │   │   └── schemas/
│   │   │       ├── conversation.schema.ts
│   │   │       └── user-settings.schema.ts
│   │   │
│   │   ├── utils/
│   │   │   ├── wake-word.ts        # Wake word detection (ported)
│   │   │   ├── tts-formatter.ts    # Format text for speech output
│   │   │   ├── location-keywords.ts # Lazy geocoding triggers (ported)
│   │   │   └── text-wrapper.ts     # HUD text formatting
│   │   │
│   │   └── constants/
│   │       └── config.ts           # Response modes, word limits, etc.
│   │
│   └── frontend/                   # (Mostly ported from current Mentra AI)
│       ├── index.html
│       ├── frontend.tsx
│       ├── App.tsx
│       ├── pages/
│       │   ├── ChatInterface.tsx   # Main chat view
│       │   └── Settings.tsx
│       └── components/
│           └── ...
│
├── docker/
│   └── Dockerfile
├── package.json
├── tsconfig.json
├── bunfig.toml
└── README.md
```

---

## Core Architecture

### 1. Session Lifecycle

```
MentraOS Device (Glasses)
        ↓
    MentraAI.onSession(session, sessionId, userId)
        ├─ Create User instance
        ├─ Initialize managers (photo, audio, transcription, location, etc.)
        ├─ Load user settings from MongoDB
        ├─ Wire up event listeners
        ├─ Connect to MongoDB for chat history

SessionManager (singleton)
└─ Map<userId, User>
    ├─ userId: string
    ├─ appSession: AppSession
    ├─ photo: PhotoManager
    ├─ transcription: TranscriptionManager
    ├─ queryProcessor: QueryProcessor
    ├─ audio: AudioManager
    ├─ location: LocationManager
    ├─ notifications: NotificationManager
    └─ chatHistory: ChatHistoryManager
```

### 2. Query Processing Pipeline

```
"Hey Mentra, what am I looking at?"
            ↓
┌─────────────────────────────────────────────────────────────────┐
│ TranscriptionManager                                            │
│  ├─ Receives transcription from SDK                            │
│  ├─ Detects wake word ("hey mentra")                           │
│  ├─ Play start listening sound (START_LISTENING_SOUND_URL)     │
│  ├─ Locks to speaker (diarization)                             │
│  ├─ Waits for final transcript                                 │
│  └─ Triggers QueryProcessor.processQuery()                     │
└─────────────────────────────────────────────────────────────────┘
            ↓
┌─────────────────────────────────────────────────────────────────┐
│ QueryProcessor.processQuery(rawText)                            │
│  ├─ Play processing sound (URL from .env: PROCESSING_SOUND_URL) │
│  ├─ Remove wake word from query                                 │
│  ├─ Capture photo (always, if camera available)                │
│  ├─ Build context:                                              │
│  │   ├─ Photo (current + last 2)                               │
│  │   ├─ Location (lazy - only if query needs it, CACHED)       │
│  │   ├─ Weather (CACHED per session to avoid API bills)        │
│  │   ├─ Local time                                              │
│  │   ├─ Phone notifications                                     │
│  │   └─ Conversation history (last 30 turns, 1hr window)       │
│  ├─ Classify response mode (QUICK/STANDARD/DETAILED)           │
│  ├─ Call MentraAgent.generate()                                │
│  ├─ Format response for TTS (if speakers)                      │
│  ├─ Output response (speak or display)                         │
│  ├─ Save to chat history (MongoDB)                             │
│  └─ Broadcast to webview via SSE                               │
└─────────────────────────────────────────────────────────────────┘
```

### 3. Agent Architecture (Mastra)

```typescript
// src/server/agent/MentraAgent.ts

import { Agent } from "@mastra/core/agent";
import { searchTool } from "./tools/search.tool";
import { calculatorTool } from "./tools/calculator.tool";
import { thinkingTool } from "./tools/thinking.tool";
import { buildSystemPrompt } from "./prompt";

export function createMentraAgent(context: AgentContext) {
  return new Agent({
    id: "mentra-ai",
    name: "Mentra AI",
    model: "google/gemini-2.5-flash",  // Primary model (2.0 is deprecated, shutting down March 2026)
    instructions: buildSystemPrompt(context),
    tools: {
      search: searchTool,
      calculator: calculatorTool,
      thinking: thinkingTool,
    },
  });
}

// AgentContext interface - includes all device capabilities
interface AgentContext {
  // Device capabilities (from session.capabilities)
  hasDisplay: boolean;      // HUD glasses
  hasSpeakers: boolean;     // Audio output
  hasCamera: boolean;       // Can take photos
  hasMicrophone: boolean;   // Always true for voice input

  // Query context
  responseMode: ResponseMode;

  // Environmental context (cached)
  location: LocationContext | null;
  localTime: string;
  notifications: Notification[];
  conversationHistory: ConversationTurn[];
}

// Usage in QueryProcessor:
const agent = createMentraAgent({
  hasDisplay: session.capabilities?.hasDisplay ?? false,
  hasSpeakers: session.capabilities?.hasSpeakers ?? false,
  hasCamera: session.capabilities?.hasCamera ?? false,
  hasMicrophone: true,  // Always has mic for voice input
  responseMode: classifyComplexity(query),
  location: locationManager.getContext(),  // Uses cached data
  localTime: timeContext,
  notifications: notificationManager.getRecentNotifications(),
  conversationHistory: chatHistoryManager.getRecentTurns(),
});

// Build content array with photos (current + up to 2 previous)
const content: ContentPart[] = [
  { type: "text", text: query },
];

// Add current photo if available
if (currentPhoto) {
  content.push({
    type: "image",
    image: currentPhoto.buffer,  // Buffer works directly with Mastra/AI SDK
  });
}

// Add previous photos for context (up to 2)
for (const prevPhoto of previousPhotos.slice(-2)) {
  content.push({
    type: "image",
    image: prevPhoto.buffer,
  });
}

const response = await agent.generate([
  { role: "user", content }
], {
  maxSteps: 8,  // Max tool call iterations
  onStepFinish: ({ toolCalls }) => {
    console.log(`Tool calls: ${toolCalls?.length || 0}`);
  }
});
```

### 4. Tool Definitions

```typescript
// src/server/agent/tools/search.tool.ts

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const searchTool = createTool({
  id: "web-search",
  description: "Search the web for current information. Use for real-time data like weather, news, sports scores, business hours, or topics you're unsure about.",
  inputSchema: z.object({
    query: z.string().describe("The search query"),
  }),
  outputSchema: z.object({
    results: z.string().describe("Search results summary"),
  }),
  execute: async ({ query }) => {
    // Jina API call
    const response = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
      headers: { "Authorization": `Bearer ${process.env.JINA_API_KEY}` }
    });
    const results = await response.text();
    return { results };
  },
});
```

```typescript
// src/server/agent/tools/calculator.tool.ts

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Parser } from "expr-eval";  // Lightweight, safe math evaluator (no eval())

const parser = new Parser();

export const calculatorTool = createTool({
  id: "calculator",
  description: "Perform mathematical calculations. Use for arithmetic, conversions, percentages, etc.",
  inputSchema: z.object({
    expression: z.string().describe("Mathematical expression to evaluate"),
  }),
  outputSchema: z.object({
    result: z.number().describe("Calculation result"),
  }),
  execute: async ({ expression }) => {
    try {
      // expr-eval is safe (no eval()), lightweight, zero dependencies
      const result = parser.evaluate(expression);
      return { result: typeof result === 'number' ? result : parseFloat(result) };
    } catch (error) {
      return { result: NaN };  // Return NaN on parse error
    }
  },
});
```

**Note:** Using `expr-eval` library because:
- No `eval()` internally (safe)
- Lightweight, zero dependencies
- Supports basic arithmetic, functions, variables
- Perfect for simple calculations without needing full mathjs

```typescript
// src/server/agent/tools/thinking.tool.ts

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const thinkingTool = createTool({
  id: "thinking",
  description: "Think through a problem step by step. Use this to reason about complex questions before answering.",
  inputSchema: z.object({
    thought: z.string().describe("Your reasoning process"),
  }),
  outputSchema: z.object({
    acknowledged: z.boolean(),
  }),
  execute: async ({ thought }) => {
    // This is just for the agent to "think out loud"
    // The thought is logged but not returned to user
    console.log(`[Thinking] ${thought}`);
    return { acknowledged: true };
  },
});
```

---

## Manager Specifications

### TranscriptionManager

**Responsibility:** Wake word detection, speaker locking, transcript handling

**Ported from:** Current Mentra AI (simplified - no follow-up mode)

```typescript
interface TranscriptionManager {
  // Setup
  setup(session: AppSession): void;
  cleanup(): void;

  // State
  isListening: boolean;
  activeSpeakerId: string | null;  // Speaker lock

  // Events
  onWakeWord(callback: (text: string, speakerId: string) => void): void;

  // Internal
  detectWakeWord(text: string): { detected: boolean; query: string };
  removeWakeWord(text: string): string;
}
```

**Key differences from current:**
- No follow-up mode (removed)
- No complex transcript accumulation logic
- Simpler state machine

### PhotoManager

**Responsibility:** Camera capture, photo storage, SSE broadcasting

**Extended from template:** Added previous photo storage for context

```typescript
interface PhotoManager {
  // Capture from glasses camera
  capturePhoto(): Promise<PhotoData | null>;

  // Current photo (most recent capture)
  getCurrentPhoto(): PhotoData | null;

  // Previous photos for context (max 2, stored as buffers in memory)
  getPreviousPhotos(): PhotoData[];

  // After capturing, current becomes previous
  private rotatePhotos(): void;

  // SSE broadcasting (from template)
  addSSEClient(client: SSEWriter): void;
  removeSSEClient(client: SSEWriter): void;
  broadcast(photo: PhotoData): void;

  // Cleanup
  destroy(): void;
}

interface PhotoData {
  buffer: Buffer;        // Raw image data (can be passed directly to Mastra)
  timestamp: number;
  requestId: string;
}
```

**Photo storage:** Current + last 2 photos stored as Buffers in memory (not base64 strings).
Photos are passed directly to Mastra agent - the AI SDK accepts Buffer format natively.

---

### QueryProcessor

**Responsibility:** Orchestrates the full query → response pipeline

```typescript
interface QueryProcessor {
  processQuery(rawText: string, speakerId?: string): Promise<void>;

  // Internal steps
  capturePhoto(): Promise<PhotoData | null>;
  buildContext(): Promise<AgentContext>;
  classifyResponseMode(query: string): ResponseMode;
  formatForTTS(text: string, hasSpeakers: boolean): string;
  outputResponse(text: string): Promise<void>;
}
```

### LocationManager

**Responsibility:** GPS, geocoding, weather

**Ported from:** Current Mentra AI (lazy geocoding logic)

**Simplified:** Using Google Maps API only (removed LocationIQ dependency)

**IMPORTANT: Caching Strategy (Per-Session)**
- Location and weather data are **cached per session** to avoid excessive Google API calls
- Only re-fetch if coordinates change significantly (>0.01 degree movement, ~1km)
- Weather cached for 30 minutes minimum
- Geocoding cached for 10 minutes or until coordinates change
- **Per-session caching prevents cross-user cache pollution**

```typescript
interface LocationManager {
  private userId: string;  // For per-session caching

  // Lazy fetch - only when needed, uses cache
  fetchIfNeeded(query: string): Promise<void>;

  // Data (returns cached if available)
  getContext(): LocationContext | null;

  // Cache management (PER SESSION)
  private cachedLocation: LocationContext | null;
  private lastGeocodedCoords: { lat: number; lng: number } | null;
  private geocodeCacheTime: number;
  private weatherCacheTime: number;

  // Internal (check cache before calling)
  // Uses Google Maps API only (no LocationIQ)
  reverseGeocode(lat: number, lng: number): Promise<GeocodedLocation>;
  fetchWeather(lat: number, lng: number): Promise<WeatherData>;

  // Cache helpers
  private shouldRefetchLocation(lat: number, lng: number): boolean;
  private shouldRefetchWeather(): boolean;

  // Cleanup on session end
  cleanup(): void;
}

interface LocationContext {
  city: string;
  state: string;
  country: string;
  lat: number;
  lng: number;
  streetAddress?: string;
  neighborhood?: string;
  timezone: string;
  weather?: {
    temperature: number;
    temperatureCelsius: number;
    condition: string;
    humidity?: number;
  };
  // Cache metadata
  geocodedAt: number;  // timestamp
  weatherFetchedAt: number;  // timestamp
}
```

### NotificationManager

**Responsibility:** Phone notification context

```typescript
interface NotificationManager {
  // Called when SDK pushes notifications
  onNotification(notification: any): void;  // SDK structure unknown, store as-is

  // Get recent notifications for context (JSON.stringify for prompt)
  getRecentNotifications(limit?: number): any[];

  // Format for prompt context
  formatForPrompt(): string {
    const notifs = this.getRecentNotifications(5);
    if (notifs.length === 0) return "No recent notifications.";
    // YOLO JSON.stringify - SDK structure unknown
    return `Recent notifications:\n${JSON.stringify(notifs, null, 2)}`;
  }

  // Clear old notifications
  cleanup(): void;
}
```

**Note:** Notification structure from SDK is unknown - we just JSON.stringify whatever we get.

### ChatHistoryManager

**Responsibility:** MongoDB conversation storage

```typescript
interface ChatHistoryManager {
  // Add turn to history
  addTurn(query: string, response: string, photoTimestamp?: number): Promise<void>;

  // Get recent turns for context
  getRecentTurns(limit?: number): ConversationTurn[];

  // Get history by date (for webview)
  getHistoryByDate(userId: string, date: Date): Promise<ConversationTurn[]>;

  // Clear history
  clearHistory(): Promise<void>;
}
```

---

## System Prompt Design

The prompt is built dynamically based on context. Key sections:

```typescript
// src/server/agent/prompt.ts

export function buildSystemPrompt(context: AgentContext): string {
  const sections = [
    buildIdentitySection(),
    buildDeviceCapabilitiesSection(context),  // NEW: Tell LLM about the glasses
    buildResponseFormatSection(context),
    buildToolUsageSection(),
    buildVisionSection(context),
    buildContextSection(context),
  ];

  // ONLY include TTS formatting if glasses have speakers (no display)
  if (context.hasSpeakers && !context.hasDisplay) {
    sections.push(buildTTSFormatSection());
  }

  // ONLY include display formatting if glasses have HUD
  if (context.hasDisplay) {
    sections.push(buildDisplayFormatSection());
  }

  return sections.join("\n\n");
}
```

### Device Capabilities Section (NEW)

The LLM must know what hardware the user's glasses have so it can accurately answer questions like "what can I do?" and not suggest features that don't exist.

```typescript
function buildDeviceCapabilitiesSection(context: AgentContext): string {
  const capabilities: string[] = [];
  const limitations: string[] = [];

  // What the glasses CAN do
  if (context.hasCamera) {
    capabilities.push("Camera - can see what the user sees and answer visual questions");
  }
  if (context.hasSpeakers) {
    capabilities.push("Speakers - responses are spoken aloud to the user");
  }
  if (context.hasDisplay) {
    capabilities.push("HUD Display - responses are shown on a heads-up display");
  }
  if (context.hasMicrophone) {
    capabilities.push("Microphone - user speaks to interact (always present)");
  }

  // What the glasses CANNOT do
  if (!context.hasCamera) {
    limitations.push("NO camera - cannot see what the user sees, cannot analyze images");
  }
  if (!context.hasSpeakers) {
    limitations.push("NO speakers - responses are displayed only, not spoken");
  }
  if (!context.hasDisplay) {
    limitations.push("NO display - responses are spoken only, not shown visually");
  }

  return `
## Device Capabilities

The user is wearing smart glasses with the following hardware:

**Available:**
${capabilities.map(c => `- ${c}`).join('\n')}

**Not Available:**
${limitations.length > 0 ? limitations.map(l => `- ${l}`).join('\n') : '- (all features available)'}

IMPORTANT: When the user asks "what can you do?" or "what can I do with these glasses?", ONLY mention capabilities that are actually available. NEVER suggest features that require hardware the user doesn't have (e.g., don't say "I can see what you're looking at" if there's no camera).
`;
}
```

### TTS Formatting Section (Only for Speaker Glasses)

```typescript
function buildTTSFormatSection(): string {
  // NOTE: This function is ONLY called if context.hasSpeakers is true
  return `
## Speech Output Formatting

Since the user will HEAR your response through speakers, format your output for natural speech:

- Write numbers as words: "fifty degrees" not "50°"
- Spell out units: "fahrenheit" not "F", "dollars" not "$"
- Spell out abbreviations: "for example" not "e.g."
- No special characters: avoid symbols like °, %, $, €
- No markdown formatting: no bullets, headers, or links
- Use natural punctuation for pauses

Examples:
- BAD: "It's 72°F with 45% humidity"
- GOOD: "It's seventy-two degrees fahrenheit with forty-five percent humidity"

- BAD: "The iPhone 15 Pro costs $999"
- GOOD: "The iPhone fifteen Pro costs nine hundred ninety-nine dollars"
`;
}
```

### Display Formatting Section (Only for HUD Glasses)

```typescript
function buildDisplayFormatSection(): string {
  // NOTE: This function is ONLY called if context.hasDisplay is true
  return `
## Display Output Formatting

Since the user will READ your response on a small HUD display:

- Keep responses extremely brief (15 words max)
- You CAN use symbols and abbreviations: 72°F, $50, 45%
- No markdown formatting
- Prioritize scannable, glanceable text
`;
}
```

### Response Mode Section

```typescript
function buildResponseFormatSection(context: AgentContext): string {
  const limits = context.hasDisplay
    ? { quick: 15, standard: 15, detailed: 15 }  // HUD: always short
    : { quick: 17, standard: 50, detailed: 100 }; // Speakers: varies

  return `
## Response Length

Your response MUST be ${limits[context.responseMode]} words or fewer.

Current mode: ${context.responseMode.toUpperCase()}
- QUICK (${limits.quick} words): Simple facts, yes/no, quick answers
- STANDARD (${limits.standard} words): Explanations, recommendations
- DETAILED (${limits.detailed} words): Complex explanations, step-by-step
`;
}
```

---

## Response Modes

| Mode | Speaker Glasses (words) | HUD Glasses (words) | Triggered By |
|------|-------------------------|---------------------|--------------|
| QUICK | 17 | 15 | Simple questions, facts |
| STANDARD | 50 | 15 | "How to", recommendations |
| DETAILED | 100 | 15 | "Explain", "why", complex |

**Classification logic** (ported from current):

```typescript
function classifyResponseMode(query: string, hasDisplay: boolean): ResponseMode {
  if (hasDisplay) return ResponseMode.QUICK;  // Always short for HUD

  const lower = query.toLowerCase();

  // Detailed triggers
  if (/explain|how does|why does|compare|analyze|in detail/.test(lower)) {
    return ResponseMode.DETAILED;
  }

  // Standard triggers
  if (/how to|what are|recommend|suggest|steps to/.test(lower)) {
    return ResponseMode.STANDARD;
  }

  return ResponseMode.QUICK;
}
```

---

## Database Schema (Mongoose)

### Conversations Collection

```typescript
// src/server/db/schemas/conversation.schema.ts

import mongoose, { Schema, Document } from 'mongoose';

interface IConversationTurn {
  query: string;
  response: string;
  timestamp: Date;
  hadPhoto: boolean;
  photoTimestamp?: number;
}

interface IConversation extends Document {
  userId: string;
  date: Date;
  turns: IConversationTurn[];
  createdAt: Date;
  updatedAt: Date;
}

const ConversationTurnSchema = new Schema<IConversationTurn>({
  query: { type: String, required: true },
  response: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  hadPhoto: { type: Boolean, default: false },
  photoTimestamp: { type: Number },
});

const ConversationSchema = new Schema<IConversation>({
  userId: { type: String, required: true, index: true },
  date: { type: Date, required: true, index: true },
  turns: [ConversationTurnSchema],
}, { timestamps: true });

// Compound index for efficient per-user, per-day queries
ConversationSchema.index({ userId: 1, date: 1 });

export const Conversation = mongoose.model<IConversation>('Conversation', ConversationSchema);
```

### User Settings Collection

```typescript
// src/server/db/schemas/user-settings.schema.ts

import mongoose, { Schema, Document } from 'mongoose';

interface IUserSettings extends Document {
  userId: string;
  theme: 'light' | 'dark';
  chatHistoryEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const UserSettingsSchema = new Schema<IUserSettings>({
  userId: { type: String, required: true, unique: true, index: true },
  theme: { type: String, enum: ['light', 'dark'], default: 'dark' },
  chatHistoryEnabled: { type: Boolean, default: true },
}, { timestamps: true });

export const UserSettings = mongoose.model<IUserSettings>('UserSettings', UserSettingsSchema);
```

### Database Connection

```typescript
// src/server/db/connection.ts

import mongoose from 'mongoose';

let isConnected = false;

export async function connectDB(): Promise<void> {
  if (isConnected) return;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI environment variable is not set');
  }

  await mongoose.connect(uri);
  isConnected = true;
  console.log('📦 Connected to MongoDB');
}

export async function disconnectDB(): Promise<void> {
  if (!isConnected) return;
  await mongoose.disconnect();
  isConnected = false;
  console.log('📦 Disconnected from MongoDB');
}
```

---

## API Endpoints

### Core APIs

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/api/chat-stream` | SSE for real-time chat updates |
| GET | `/api/transcription-stream` | SSE for live transcription |
| POST | `/api/chat/message` | Debug: send text message |
| GET | `/api/chat/history` | Get chat history |
| DELETE | `/api/chat/clear` | Clear chat history |
| GET | `/api/settings` | Get user settings |
| PATCH | `/api/settings` | Update user settings |

### Photo APIs (from template)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/photo-stream` | SSE for photo updates |
| GET | `/api/photo/:id` | Get photo by ID |
| GET | `/api/latest-photo` | Get most recent photo |

---

## Implementation Phases

### Phase 1: Foundation (Day 1-2) ✅ COMPLETE

1. **Configure project** ✅
   - Rename package to `mentra-ai` in package.json
   - Configure MongoDB connection
   - **ENV NOTE:** `GOOGLE_GENERATIVE_AI_API_KEY` is already set

2. **Create folder structure** ✅
   - Set up `agent/`, `manager/`, `db/`, `utils/`, `constants/` directories
   - Create placeholder files

3. **Port utilities** ✅
   - `wake-word.ts` (from current `wakeWords.ts`)
   - `location-keywords.ts` (from current)
   - `text-wrapper.ts` (from current `wrapText`)
   - `tts-formatter.ts` (new)

4. **Set up MongoDB with Mongoose** ✅
   - Install: `bun add mongoose`
   - Connection module (`db/connection.ts`)
   - Mongoose schemas:
     - `conversation.schema.ts` - Conversation model
     - `user-settings.schema.ts` - UserSettings model

5. **Install Google Maps client** ✅
   - Install: `bun add @googlemaps/google-maps-services-js`
   - Used for reverse geocoding (lat/lng → address)

### Phase 2: Managers (Day 2-3) ✅ COMPLETE

1. **TranscriptionManager** ✅
   - Port wake word detection
   - Implement speaker lock
   - Remove follow-up mode complexity

2. **LocationManager** ✅
   - Port lazy geocoding
   - Port weather API integration
   - Test with Google Maps API

3. **NotificationManager** ✅
   - Implement notification storage
   - Add cleanup logic

4. **ChatHistoryManager** ✅
   - MongoDB CRUD operations
   - Per-day conversation grouping

### Phase 3: Agent (Day 3-4) ✅ COMPLETE

1. **Install dependencies** ✅
   ```bash
   bun add @mastra/core zod expr-eval
   ```

   - `@mastra/core` - Agent framework (includes Google Gemini support built-in)
   - `zod` - Schema validation for tools
   - `expr-eval` - Safe math expression evaluator (no eval())
     - **Types:** Bundled (`parser.d.ts`) - no `@types/expr-eval` needed

   **NOTE:** `@ai-sdk/google` is NOT needed - Mastra has it built into its model router.

2. **Create tools** ✅
   - `search.tool.ts` (Jina API)
   - `calculator.tool.ts`
   - `thinking.tool.ts`

3. **Build prompt system** ✅
   - Port from `unifiedPrompt.ts`
   - Add TTS formatting section
   - Add response mode logic

4. **Create MentraAgent** ✅
   - Agent factory function
   - Context injection
   - Tool configuration

### Phase 4: Query Pipeline (Day 4-5) ✅ COMPLETE

1. **QueryProcessor** ✅
   - Wire up all managers
   - Photo capture logic
   - Context building
   - Agent invocation
   - Response output (speak/display)
   - Chat history storage

2. **MentraAI app class** ✅
   - Session lifecycle
   - Manager initialization
   - Event wiring

3. **Integration testing** ✅
   - Wake word → response flow
   - Photo capture
   - Web search
   - Location queries

### Phase 5: Frontend (Day 5-6) ✅ COMPLETE

1. **Port frontend components** ✅
   - ChatInterface.tsx
   - Settings.tsx
   - Message bubbles
   - Image viewer

2. **Update for new API** ✅
   - SSE connections
   - History fetching
   - Settings management

3. **Styling** ✅
   - Dark/light mode
   - Responsive for glasses webview

### Phase 6: Polish (Day 6-7) ✅ COMPLETE

1. **Test all success criteria** ✅
   - "What am I looking at?" - Wake word detection, photo capture, vision model
   - "Where am I?" - Location fetching, geocoding
   - "What's the weather?" - Weather API integration
   - "Who won the skiing Olympics gold medal in 2026?" - Web search
   - No response repetition - Single response per query
   - TTS-friendly output - formatForTTS tested and working

2. **Error handling** ✅
   - Timeouts - SSE heartbeats, connection management
   - API failures - Try/catch blocks throughout
   - Empty responses - Fallback messages

3. **Documentation** ✅
   - Architecture plan document complete
   - Code documented with comments
   - Environment variables documented

---

## Files to Port (Copy/Modify)

| Source (Current) | Destination (New) | Changes Needed |
|------------------|-------------------|----------------|
| `constant/wakeWords.ts` | `utils/wake-word.ts` | Clean up commented code |
| `constant/unifiedPrompt.ts` | `agent/prompt.ts` | Remove TPA sections, add TTS |
| `utils/geocoding-utils/*` | `utils/location-keywords.ts` | Simplify |
| `utils/wrapText.ts` | `utils/text-wrapper.ts` | Keep as-is |
| `frontend/**` | `frontend/**` | Update API calls |

## Files to NOT Port

- `agents/tools/SmartAppControlTool.ts`
- `agents/tools/TpaCommandsTool.ts`
- `agents/tools/TpaToolInvokeTool.ts`
- `agents/tools/TpaTool.ts`
- `agents/tools/IntelligentAppMatchingTool.ts`
- `utils/disambiguation-detector.util.ts`
- `manager/chat.manager.ts` (rewrite from scratch)
- All LangChain code

---

## Environment Variables

**NOTE:** The `.env` file is already configured. Do not modify it - it's managed separately.

Required env vars (already set):
- `PORT` - Server port
- `PACKAGE_NAME` - MentraOS package identifier
- `MENTRAOS_API_KEY` - SDK authentication
- `MONGODB_URI` - Database connection
- `GOOGLE_GENERATIVE_AI_API_KEY` - Mastra requires this exact name for Gemini (already set)
- `GOOGLE_MAPS_API_KEY` - For geocoding
- `GOOGLE_WEATHER_API_KEY` - For weather data
- `JINA_API_KEY` - Web search
- `START_LISTENING_SOUND_URL` - Audio URL when wake word detected

---

## Success Criteria

1. **"Hey Mentra, what am I looking at?"**
   - Wake word detected
   - Photo captured
   - Vision model analyzes image
   - Concise description spoken/displayed

2. **"Hey Mentra, where am I?"**
   - Location fetched (lazy)
   - Geocoded to address
   - "You're in the Hayes Valley area in San Francisco"

3. **"Hey Mentra, what is the weather today?"**
   - Weather API called
   - TTS-friendly: "It's seventy-two degrees fahrenheit and sunny"

4. **"Hey Mentra, who won the skiing Olympics gold medal in 2026?"**
   - Web search triggered
   - Recent results returned
   - Concise answer

5. **No response repetition**
   - Single response per query
   - No re-processing

6. **TTS-friendly output**
   - No special characters for speaker glasses
   - Numbers spelled out
   - Natural speech patterns

---

## References

- [Mastra Documentation](https://mastra.ai/docs)
- [Mastra createTool() Reference](https://mastra.ai/reference/tools/create-tool)
- [@mentra/sdk Documentation](internal)
- [Hono Documentation](https://hono.dev/)
- [Current Mentra AI Codebase](../Mentra-AI/)
