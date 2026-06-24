/**
 * Chat API
 *
 * Handles chat SSE stream and message broadcasting.
 */

import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { sessions } from "../manager/SessionManager";
import type { AuthContext } from "../utils/auth";

// Custom writer interface for SSE clients
interface SSEWriter {
  write: (data: string) => Promise<void>;
  id: string;
}

// SSE clients for chat updates per user
const chatClients = new Map<string, Set<SSEWriter>>();

// Queued events for users with no connected SSE clients (fixes first-query race condition)
// Cleared when the user session ends (onStop)
const pendingEvents = new Map<string, Array<string>>();

/**
 * Add a chat SSE client for a user
 */
function addChatClient(userId: string, writer: SSEWriter) {
  if (!chatClients.has(userId)) {
    chatClients.set(userId, new Set());
  }
  chatClients.get(userId)!.add(writer);
}

/**
 * Remove a chat SSE client for a user
 */
function removeChatClient(userId: string, writerId: string) {
  const clients = chatClients.get(userId);
  if (clients) {
    for (const client of clients) {
      if (client.id === writerId) {
        clients.delete(client);
        break;
      }
    }
    if (clients.size === 0) {
      chatClients.delete(userId);
    }
  }
}

/**
 * Clear queued events for a user (called on session end)
 */
export function clearPendingEvents(userId: string) {
  pendingEvents.delete(userId);
}

/**
 * Broadcast a chat event to all clients for a user
 */
export function broadcastChatEvent(userId: string, event: {
  type: 'message' | 'processing' | 'idle' | 'history' | 'session_started' | 'session_ended' | 'session_heartbeat' | 'session_reconnecting' | 'session_reconnected' | 'wake_word';
  [key: string]: unknown;
}) {
  const clients = chatClients.get(userId);
  const data = JSON.stringify(event);

  if (!clients || clients.size === 0) {
    // No SSE clients connected — queue for later
    if (!pendingEvents.has(userId)) pendingEvents.set(userId, []);
    pendingEvents.get(userId)!.push(data);
    return;
  }

  for (const writer of clients) {
    writer.write(`data: ${data}\n\n`).catch(() => {
      clients.delete(writer);
    });
  }
}

/**
 * Chat SSE stream endpoint.
 *
 * Auth-only (no live glasses session required): the webview chat works even
 * when no glasses are connected. We get-or-create the User so a webview-only
 * tester has somewhere to read history from; the heartbeat below still reports
 * whether glasses are actually active.
 */
export async function chatStream(c: AuthContext) {
  const userId = c.get("userId");
  const user = sessions.getOrCreate(userId);

  const recipientId = c.req.query("recipientId");

  return streamSSE(c, async (stream) => {
    const writerId = `${userId}-${Date.now()}`;

    // Create a custom writer that we can track
    const customWriter: SSEWriter = {
      id: writerId,
      write: async (data: string) => {
        await stream.write(data);
      },
    };

    addChatClient(userId, customWriter);

    // Send connected event
    await stream.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

    // Always send chat history first so the frontend has full conversation context
    const recentTurns = user.chatHistory.getRecentTurns(30);
    if (recentTurns.length > 0) {
      const messages = recentTurns.flatMap((turn, index) => [
        {
          id: `${Date.now()}-${index * 2}`,
          senderId: userId,
          recipientId: recipientId || "mentra-ai",
          content: turn.query,
          timestamp: turn.timestamp.toISOString(),
          image: turn.photoDataUrl,
        },
        {
          id: `${Date.now()}-${index * 2 + 1}`,
          senderId: recipientId || "mentra-ai",
          recipientId: userId,
          content: turn.response,
          timestamp: turn.timestamp.toISOString(),
        },
      ]);

      await stream.write(
        `data: ${JSON.stringify({ type: "history", messages })}\n\n`,
      );
    }

    // Then flush any events that were broadcast before this client connected
    const queued = pendingEvents.get(userId);
    if (queued && queued.length > 0) {
      for (const event of queued) {
        await stream.write(`data: ${event}\n\n`);
      }
      pendingEvents.delete(userId);
    }

    // Send immediate session status so frontend doesn't wait up to 15s
    const currentUser = sessions.get(userId);
    const isCurrentlyActive = currentUser != null && currentUser.appSession != null;
    await stream.write(`data: ${JSON.stringify({
      type: "session_heartbeat",
      active: isCurrentlyActive,
      timestamp: new Date().toISOString(),
    })}\n\n`);

    // Session heartbeat — periodic status ping with active/inactive state
    const heartbeatInterval = setInterval(async () => {
      try {
        const heartbeatUser = sessions.get(userId);
        const isActive = heartbeatUser != null && heartbeatUser.appSession != null;
        await stream.write(`data: ${JSON.stringify({
          type: "session_heartbeat",
          active: isActive,
          timestamp: new Date().toISOString(),
        })}\n\n`);
      } catch {
        clearInterval(heartbeatInterval);
      }
    }, 15000);

    // Wait for abort signal
    stream.onAbort(() => {
      clearInterval(heartbeatInterval);
      removeChatClient(userId, writerId);
    });

    // Keep stream open
    await new Promise(() => {});
  });
}

/**
 * POST /api/chat/send — process a message typed into the webview chat box.
 *
 * Auth-only, no glasses required (the primary use is testing the assistant from
 * the phone without speaking). Get-or-creates the User, runs the text-chat
 * pipeline (relaxed length, delegation supported), and returns the answer. The
 * message + reply are also broadcast on the SSE stream above, which is how any
 * async delegation follow-up reaches the open client.
 */
export async function chatSend(c: AuthContext) {
  const userId = c.get("userId");

  let body: { text?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "text is required" }, 400);

  const user = sessions.getOrCreate(userId);
  // initialize() is idempotent (in-memory MVP no-op); safe for a fresh
  // webview-only user as well as one already connected to glasses.
  await user.initialize();

  const result = await user.queryProcessor.processTextQuery(text);
  return c.json({ ok: true, ...result });
}
