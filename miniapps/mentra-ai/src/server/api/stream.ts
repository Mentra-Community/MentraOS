import { streamSSE } from "hono/streaming";

import type { SessionContext } from "../utils/auth";

/** GET /photo-stream: SSE for real-time photo updates */
export function photoStream(c: SessionContext) {
  const user = c.get("user");
  const userId = c.get("userId");

  console.log(`[SSE Photo] Client connected for user: ${userId}`);

  return streamSSE(c, async (stream) => {
    const client = {
      write: (data: string) => stream.writeSSE({ data }),
      userId,
      close: () => stream.close(),
    };

    user.photo.addSSEClient(client);

    await stream.writeSSE({
      data: JSON.stringify({ type: "connected" }),
    });

    // Send existing photos
    for (const photo of user.photo.getAllMap().values()) {
      const base64Data = photo.buffer.toString("base64");
      await stream.writeSSE({
        data: JSON.stringify({
          requestId: photo.requestId,
          timestamp: photo.timestamp.getTime(),
          mimeType: photo.mimeType,
          filename: photo.filename,
          size: photo.size,
          base64: base64Data,
          dataUrl: `data:${photo.mimeType};base64,${base64Data}`,
        }),
      });
    }

    stream.onAbort(() => {
      console.log(`[SSE Photo] Client disconnected for user: ${userId}`);
      user.photo.removeSSEClient(client);
    });

    while (true) {
      try {
        await stream.writeSSE({ data: JSON.stringify({ type: "heartbeat" }) });
      } catch {
        break;
      }
      await stream.sleep(15000);
    }
  });
}

/** GET /transcription-stream: SSE for real-time transcriptions */
export function transcriptionStream(c: SessionContext) {
  const user = c.get("user");
  const userId = c.get("userId");

  console.log(`[SSE Transcription] Client connected for user: ${userId}`);

  return streamSSE(c, async (stream) => {
    const client = {
      write: (data: string) => stream.writeSSE({ data }),
      userId,
      close: () => stream.close(),
    };

    user.transcription.addSSEClient(client);

    await stream.writeSSE({
      data: JSON.stringify({ type: "connected" }),
    });

    stream.onAbort(() => {
      console.log(
        `[SSE Transcription] Client disconnected for user: ${userId}`,
      );
      user.transcription.removeSSEClient(client);
    });

    while (true) {
      try {
        await stream.writeSSE({ data: JSON.stringify({ type: "heartbeat" }) });
      } catch {
        break;
      }
      await stream.sleep(15000);
    }
  });
}
