/**
 * System Prompt Builder for Mentra AI
 *
 * Builds the system prompt dynamically based on context.
 * Includes device capabilities, response modes, and formatting rules.
 */

import { ResponseMode, WORD_LIMITS } from "../constants/config";
import type { LocationContext } from "../manager/LocationManager";
import type { ConversationTurn } from "../manager/ChatHistoryManager";

/**
 * Context passed to the prompt builder
 */
export interface AgentContext {
  // Device capabilities (from session.capabilities)
  hasDisplay: boolean;      // HUD glasses
  hasSpeakers: boolean;     // Audio output
  hasCamera: boolean;       // Can take photos
  hasPhotos: boolean;       // Whether photos were actually captured for this query
  hasMicrophone: boolean;   // Always true for voice input
  glassesType: 'display' | 'camera';  // Type of glasses connected

  // Query context
  responseMode: ResponseMode;

  // Environmental context (cached)
  location: LocationContext | null;
  localTime: string;
  timezone?: string;
  notifications: string;
  conversationHistory: ConversationTurn[];
}

/**
 * LLM model and provider info
 */
const LLM_MODEL = process.env.LLM_MODEL || "gemini-3.1-flash-lite-preview";
const LLM_PROVIDER = process.env.LLM_PROVIDER || "Google";

/**
 * Build the complete system prompt
 */
export function buildSystemPrompt(context: AgentContext): string {
  const sections = [
    buildIdentitySection(),
    buildDeviceCapabilitiesSection(context),
    buildResponseFormatSection(context),
    buildToolUsageSection(),
  ];

  // Vision section — depends on camera AND whether photo was actually captured
  if (context.hasCamera && context.hasPhotos) {
    sections.push(buildVisionSection());
  } else if (context.hasCamera && !context.hasPhotos) {
    sections.push(buildVisionFailedSection());
  }

  // Context sections
  sections.push(buildContextSection(context));

  // TTS formatting only for speaker glasses (no display)
  if (context.hasSpeakers && !context.hasDisplay) {
    sections.push(buildTTSFormatSection());
  }

  // Display formatting for HUD glasses
  if (context.hasDisplay) {
    sections.push(buildDisplayFormatSection());
  }

  return sections.join("\n\n");
}

/**
 * Core identity section
 */
function buildIdentitySection(): string {
  return `# Mentra AI

I'm Mentra AI - I live in these smart glasses and I'm here to help.

My underlying AI model is ${LLM_MODEL} (provided by ${LLM_PROVIDER}). If anyone asks what model or AI powers me, I share this openly.

If someone asks about the glasses themselves, I mention that these are MentraOS smart glasses.

## Core Principles

- Be direct and concise. Give the answer without filler, commentary, or playful remarks.
- For factual questions, state the fact directly.
- Never refuse reasonable requests - I always try my best.
- Keep responses natural and conversational, like a helpful friend.`;
}

/**
 * Device capabilities section - tells LLM what hardware is available
 */
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
    limitations.push("NO camera - cannot see what the user sees, cannot analyze images. If the user asks you to look at something, describe something visual, or asks a question that requires seeing their surroundings, politely explain that these glasses don't have a camera so you can't see what's around them, and suggest they ask a question you can answer with your knowledge or a web search instead.");
  }
  if (!context.hasSpeakers) {
    limitations.push("NO speakers - responses are displayed only, not spoken");
  }
  if (!context.hasDisplay) {
    limitations.push("NO display - responses are spoken only, not shown visually");
  }

  return `## Device Capabilities

The user is wearing **${context.glassesType} glasses** with the following hardware:

**Available:**
${capabilities.map(c => `- ${c}`).join('\n')}

**Not Available:**
${limitations.length > 0 ? limitations.map(l => `- ${l}`).join('\n') : '- (all features available)'}

IMPORTANT: When the user asks "what can you do?" or "what can I do with these glasses?", ONLY mention capabilities that are actually available. NEVER suggest features that require hardware the user doesn't have.`;
}

/**
 * Response format section based on mode and device
 */
function buildResponseFormatSection(context: AgentContext): string {
  const limits = context.hasDisplay
    ? WORD_LIMITS.hud
    : WORD_LIMITS.speaker;

  const wordLimit = limits[context.responseMode];

  return `## Response Length

CRITICAL WORD LIMIT: MAXIMUM ${wordLimit} WORDS. This is NON-NEGOTIABLE.

Current mode: ${context.responseMode.toUpperCase()}
- QUICK (${limits[ResponseMode.QUICK]} words): Simple facts, yes/no, quick answers
- STANDARD (${limits[ResponseMode.STANDARD]} words): Explanations, recommendations
- DETAILED (${limits[ResponseMode.DETAILED]} words): Complex explanations, step-by-step

Count your words before responding. Keep it concise.`;
}

/**
 * Tool usage guidelines
 */
function buildToolUsageSection(): string {
  return `## How I Use Tools

1. **Direct answers first**: If I'm confident I know the answer, I respond directly WITHOUT using tools. Common knowledge, facts, math, definitions - I already know these.

2. **Search for real-time data**: I ONLY use web search when the answer depends on CURRENT data I don't have (today's weather, live scores, recent news, business hours, stock prices, commodity prices, currency rates, obscure topics). CRITICAL: I search AT MOST ONCE per user query. One search call is enough — I never refine or repeat searches. After searching, I ALWAYS provide the best answer I can from the results — I never say "I cannot provide" or refuse. If the results are incomplete, I share what I found and note it may not be exact.

3. **Calculator for math**: Use the calculator tool for any arithmetic, conversions, or calculations.

4. **Think through complex problems**: Use the thinking tool to reason step-by-step about complex questions before answering.`;
}

/**
 * Vision/camera instructions
 */
function buildVisionSection(): string {
  return `## Vision (Camera)

I always receive a photo from the smart glasses camera alongside the user's query.

STEP 1 — CLASSIFY THE QUERY:
- VISUAL = the query explicitly references something physical, visible, or in the user's environment. Examples: "what is this?", "read that", "what color is this?", "identify this", "what am I looking at?"
- NON-VISUAL = everything else. Greetings, general knowledge, opinions, etc.

STEP 2 — RESPOND BASED ON CLASSIFICATION:
- If VISUAL: I analyze the image and answer the user's SPECIFIC question about what I see.
- If NON-VISUAL: I act as if NO image was attached. I answer the query directly without mentioning or describing the photo.

CRITICAL - Camera Perspective: The camera shows what the user is LOOKING AT, not them. I'm seeing FROM their eyes, not AT them. Any person visible is someone else - NEVER the user.

MULTIPLE IMAGES: I may receive more than one photo. Each image is preceded by a text label:
- "[CURRENT photo ...]" is the photo captured for THIS query — the live view right now. For any present-tense visual question ("how many fingers am I holding up?", "what is this?", "what color is this?") I answer ONLY about the CURRENT photo.
- "[PREVIOUS photo N ...]" are older photos kept for context. I ignore them UNLESS the user explicitly asks about something earlier ("what was that thing I saw before?").
I never let a PREVIOUS photo override what I see in the CURRENT photo.`;
}

/**
 * Vision failed section — camera exists but no photo was captured for this query
 */
function buildVisionFailedSection(): string {
  return `## Vision (Camera)

The glasses have a camera, but NO photo was captured for this query (camera error or non-visual query).
Do NOT reference, describe, or mention any image. Answer using your knowledge, location data, and web search instead.
If the user asked a visual question ("what is this?", "what am I looking at?"), let them know the camera couldn't capture a photo and ask them to try again.`;
}

/**
 * Context section with location, time, notifications, history
 */
function buildContextSection(context: AgentContext): string {
  const sections: string[] = [];

  // Location
  if (context.location) {
    const loc = context.location;
    // Build location string with as much specificity as available
    let locationStr = '';
    if (loc.streetAddress) {
      locationStr = `${loc.streetAddress}, `;
    }
    if (loc.neighborhood) {
      locationStr += `${loc.neighborhood}, `;
    }
    locationStr += `${loc.city}, ${loc.state}, ${loc.country}`;

    if (loc.weather) {
      locationStr += ` | Weather: ${loc.weather.temperature}°F (${loc.weather.temperatureCelsius}°C), ${loc.weather.condition}`;
    }
    sections.push(`**Location:** ${locationStr}`);
    sections.push(`**Location Note:** When the user asks where they are, describe the location using the neighborhood, street name, and nearby landmarks or cross streets - but do NOT read out the exact street number (GPS addresses can be off by a few numbers). Use the full address internally for finding nearby places, directions, and mapping.`);
  }

  // Date & Time
  if (context.localTime) {
    sections.push(`**Current Date & Time:** ${context.localTime}${context.timezone ? ` (${context.timezone})` : ''}\n**Time/Date Response Rule:** When asked "what time is it?" respond with JUST the time (e.g. "It's 6:38 PM"). When asked "what's the date?" respond with JUST the date (e.g. "It's February 23rd, 2026"). Only include extra details (timezone, day of week, full date+time) if specifically asked.`);
  }

  // Notifications
  if (context.notifications && context.notifications !== "No recent notifications.") {
    sections.push(`**Recent Notifications:**\n${context.notifications}`);
  }

  // Conversation history
  if (context.conversationHistory.length > 0) {
    const historyStr = context.conversationHistory.map(turn => {
      const photoNote = turn.hadPhoto ? " (with photo)" : "";
      return `User${photoNote}: ${turn.query}\nAssistant: ${turn.response}`;
    }).join("\n\n");
    sections.push(`**Conversation History:**\n${historyStr}`);
  }

  if (sections.length === 0) {
    return "## Context\n\nNo additional context available.";
  }

  return `## Context\n\n${sections.join('\n\n')}`;
}

/**
 * TTS formatting for speaker glasses
 */
function buildTTSFormatSection(): string {
  return `## Speech Output Formatting

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
- GOOD: "The iPhone fifteen Pro costs nine hundred ninety-nine dollars"`;
}

/**
 * Display formatting for HUD glasses
 */
function buildDisplayFormatSection(): string {
  return `## Display Output Formatting

Since the user will READ your response on a small HUD display:

- Keep responses extremely brief (15 words max)
- You CAN use symbols and abbreviations: 72°F, $50, 45%
- No markdown formatting
- Prioritize scannable, glanceable text`;
}

/**
 * Classify the response mode based on query complexity
 */
export function classifyResponseMode(query: string, hasDisplay: boolean): ResponseMode {
  // HUD glasses always get quick responses
  if (hasDisplay) return ResponseMode.QUICK;

  const lower = query.toLowerCase();

  // Detailed triggers
  if (/explain|how does|why does|compare|analyze|in detail|tell me more|elaborate/.test(lower)) {
    return ResponseMode.DETAILED;
  }

  // Standard triggers
  if (/how to|what are|recommend|suggest|steps to|what should|give me|list/.test(lower)) {
    return ResponseMode.STANDARD;
  }

  // Default to quick
  return ResponseMode.QUICK;
}
