/**
 * Chat channel bridge — the local replacement for the cloud app's SSE stream.
 *
 * The cloud ChatInterface opened an EventSource and switched on `data.type`
 * ("message" | "wake_word" | "processing" | "idle" | "history" | …). Here the
 * same events arrive over the `chat:event` SDK channel from the background.
 *
 * `subscribeChatEvents(handler)` delivers each event (already parsed) and
 * immediately requests a history snapshot so a freshly-opened webview hydrates,
 * mirroring the cloud "history" event. Returns an unsubscribe fn.
 */

import "../../shared/channels"
import type {ChatEvent, ChatMessage} from "../../shared/types"

/** Event shape the cloud ChatInterface expects (senderId/recipientId/etc). */
export type IncomingChatEvent =
  | {
      type: "message"
      id: string
      senderId: string
      recipientId: string
      content: string
      timestamp: string
      image?: string
    }
  | {type: "wake_word"}
  | {type: "processing"}
  | {type: "idle"}
  | {type: "history"; messages: Array<ChatMessage & {recipientId: string}>}

const RECIPIENT = "mentra-ai"
const USER = "local-user"

/** Map a background ChatEvent into the cloud-shaped event the UI consumes. */
function adapt(event: ChatEvent): IncomingChatEvent | null {
  switch (event.type) {
    case "message":
      return {
        type: "message",
        id: event.id,
        // Background tags the wearer as "user"; the UI compares against userId.
        senderId: event.senderId === "user" ? USER : event.senderId,
        recipientId: event.senderId === "user" ? RECIPIENT : USER,
        content: event.content,
        timestamp: event.timestamp,
        image: event.image,
      }
    case "wake_word":
      return {type: "wake_word"}
    case "processing":
      return {type: "processing"}
    case "idle":
      return {type: "idle"}
    case "history":
      return {
        type: "history",
        messages: event.messages.map((m) => ({
          ...m,
          senderId: m.senderId === "user" ? USER : m.senderId,
          recipientId: m.senderId === "user" ? RECIPIENT : USER,
        })),
      }
    default:
      return null
  }
}

export function subscribeChatEvents(handler: (event: IncomingChatEvent) => void): () => void {
  const off = mentra.on("chat:event", (event: ChatEvent) => {
    const adapted = adapt(event)
    if (adapted) handler(adapted)
  })

  // Hydrate history immediately (the cloud app got this as an SSE "history" event).
  mentra
    .request("chat:get-history", undefined as never)
    .then((messages: ChatMessage[]) => {
      handler({
        type: "history",
        messages: messages.map((m) => ({
          ...m,
          senderId: m.senderId === "user" ? USER : m.senderId,
          recipientId: m.senderId === "user" ? RECIPIENT : USER,
        })),
      })
    })
    .catch(() => {})

  return off
}
