import type { SessionContext } from "../utils/auth";

/** GET /latest-photo: metadata for the most recent photo */
export function getLatestPhoto(c: SessionContext) {
  const user = c.get("user");

  const photos = user.photo.getAll();
  if (photos.length === 0) {
    return c.json({ error: "No photos available" }, 404);
  }

  const latest = photos[0];
  return c.json({
    requestId: latest.requestId,
    timestamp: latest.timestamp.getTime(),
    hasPhoto: true,
  });
}

/** GET /photo/:requestId: raw photo image data */
export function getPhotoData(c: SessionContext) {
  const user = c.get("user");
  const userId = c.get("userId");

  const requestId = c.req.param("requestId");
  if (!requestId) return c.json({ error: "Photo not found" }, 404);

  const photo = user.photo.getPhoto(requestId);
  if (!photo || photo.userId !== userId) {
    return c.json({ error: "Photo not found" }, 404);
  }

  return new Response(new Uint8Array(photo.buffer), {
    headers: {
      "Content-Type": photo.mimeType,
      "Cache-Control": "no-cache",
    },
  });
}

/** GET /photo-base64/:requestId: photo as base64 JSON */
export function getPhotoBase64(c: SessionContext) {
  const user = c.get("user");
  const userId = c.get("userId");

  const requestId = c.req.param("requestId");
  if (!requestId) return c.json({ error: "Photo not found" }, 404);

  const photo = user.photo.getPhoto(requestId);
  if (!photo || photo.userId !== userId) {
    return c.json({ error: "Photo not found" }, 404);
  }

  const base64Data = photo.buffer.toString("base64");
  return c.json({
    requestId: photo.requestId,
    timestamp: photo.timestamp.getTime(),
    mimeType: photo.mimeType,
    filename: photo.filename,
    size: photo.size,
    base64: base64Data,
    dataUrl: `data:${photo.mimeType};base64,${base64Data}`,
  });
}
