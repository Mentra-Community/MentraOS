/**
 * Mentra Agent - Main AI agent using Mastra
 *
 * Creates and manages the Mastra agent for query processing.
 */

import { Agent } from "@mastra/core/agent";
import { searchTool, calculatorTool, thinkingTool } from "./tools";
import { createAskAgentTool, type DelegateFn } from "./tools/askAgent.tool";
import { buildSystemPrompt, classifyResponseMode, type AgentContext } from "./prompt";
import { ResponseMode, AGENT_SETTINGS } from "../constants/config";
import type { LocationContext } from "../manager/LocationManager";
import type { ConversationTurn } from "../manager/ChatHistoryManager";

/**
 * Content part for multimodal messages
 */
export interface ContentPart {
  type: "text" | "image";
  text?: string;
  image?: Buffer;
}

/**
 * Agent generation options
 */
export interface GenerateOptions {
  query: string;
  photos?: Buffer[];
  context: {
    hasDisplay: boolean;
    hasSpeakers: boolean;
    hasCamera: boolean;
    hasPhotos: boolean;
    glassesType: 'display' | 'camera';
    location: LocationContext | null;
    localTime: string;
    timezone?: string;
    notifications: string;
    conversationHistory: ConversationTurn[];
    /** "glasses" (default) or "chat" (webview text box — relaxed length). */
    channel?: 'glasses' | 'chat';
  };
  onToolCall?: (toolName: string) => void;
  /**
   * Optional escalation path to the user's giga-agent. When provided, the
   * agent gains the `ask_agent` tool and the prompt's delegation rules.
   */
  delegate?: DelegateFn;
  /** Override the Mastra model string (from the user's Settings → Model). */
  model?: string;
}

/**
 * Agent generation result
 */
export interface GenerateResult {
  response: string;
  toolCalls: number;
}

/**
 * Create a Mentra agent with the given context.
 *
 * When a `delegate` is supplied, the agent also gets the `ask_agent` tool so
 * it can escalate multi-step / personal-account work to the user's giga-agent.
 */
export function createMentraAgent(context: AgentContext, delegate?: DelegateFn, model?: string): Agent {
  const tools: Record<string, ReturnType<typeof createAskAgentTool>> | Record<string, unknown> = {
    search: searchTool,
    calculator: calculatorTool,
    thinking: thinkingTool,
  };

  if (delegate) {
    (tools as Record<string, unknown>).ask_agent = createAskAgentTool(delegate);
  }

  return new Agent({
    id: "mentra-ai",
    name: "Mentra AI",
    model: model || AGENT_SETTINGS.model,
    instructions: buildSystemPrompt(context),
    tools: tools as any,
  });
}

/**
 * Generate a response using the Mentra agent
 */
export async function generateResponse(options: GenerateOptions): Promise<GenerateResult> {
  const { query, photos, context } = options;

  // Classify response mode
  const responseMode = classifyResponseMode(query, context.hasDisplay);

  // Build full agent context
  const agentContext: AgentContext = {
    hasDisplay: context.hasDisplay,
    hasSpeakers: context.hasSpeakers,
    hasCamera: context.hasCamera,
    hasPhotos: context.hasPhotos,
    hasMicrophone: true,  // Always true
    glassesType: context.glassesType,
    responseMode,
    location: context.location,
    localTime: context.localTime,
    timezone: context.timezone,
    notifications: context.notifications,
    conversationHistory: context.conversationHistory,
    agentEnabled: Boolean(options.delegate),
    channel: context.channel ?? 'glasses',
  };

  // Create agent with context (delegation tool added when a delegate is given)
  const agent = createMentraAgent(agentContext, options.delegate, options.model);

  // Build content array
  const content: ContentPart[] = [
    { type: "text", text: query },
  ];

  // Add photos (current + previous). Photos are ordered current-first
  // (see PhotoManager.getPhotosForContext). Each image is prefixed with a
  // label so the model knows which one to answer about — without it, an
  // identical visual query ("how many fingers?") can latch onto a stale photo.
  if (photos && photos.length > 0) {
    photos.forEach((photoBuffer, i) => {
      content.push({
        type: "text",
        text: i === 0
          ? "[CURRENT photo — what the user is looking at right now. Answer about THIS image.]"
          : `[PREVIOUS photo ${i} — older context only. Ignore unless the user explicitly asks about something earlier.]`,
      });
      content.push({
        type: "image",
        image: photoBuffer,
      });
    });
  }

  console.log(`🤖 Generating response for: "${query.slice(0, 50)}${query.length > 50 ? '...' : ''}"`);
  console.log(`   Mode: ${responseMode}, Photos: ${photos?.length || 0}, hasPhotos: ${context.hasPhotos}, History: ${context.conversationHistory.length}`);

  let toolCallCount = 0;

  try {
    // Generate response
    const result = await agent.generate([
      {
        role: "user",
        content: content as any,  // Type coercion for Mastra
      },
    ], {
      maxSteps: AGENT_SETTINGS.maxSteps,
      onStepFinish: ({ toolCalls }) => {
        if (toolCalls) {
          toolCallCount += toolCalls.length;
          console.log(`   Tool calls this step: ${toolCalls.length}`);
          if (options.onToolCall) {
            for (const tc of toolCalls) {
              if (tc.payload?.toolName) {
                options.onToolCall(tc.payload.toolName);
              }
            }
          }
        }
      },
    });

    const response = typeof result.text === 'string' ? result.text : String(result.text || '');

    console.log(`✅ Response generated (${response.length} chars, ${toolCallCount} tool calls)`);

    return {
      response,
      toolCalls: toolCallCount,
    };

  } catch (error) {
    console.error("❌ Agent generation error:", error);
    throw error;
  }
}

/**
 * Quick helper to get response mode from query
 */
export { classifyResponseMode } from "./prompt";
export { ResponseMode } from "../constants/config";
