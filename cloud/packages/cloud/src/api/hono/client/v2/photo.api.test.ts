/// <reference types="bun-types" />

import { beforeEach, describe, expect, mock, test } from "bun:test";
import jwt from "jsonwebtoken";

// The middleware reads AUGMENTOS_AUTH_JWT_SECRET at module load and throws if
// unset. Set it BEFORE importing.
process.env.AUGMENTOS_AUTH_JWT_SECRET = "test-secret";
process.env.MENTRA_PHOTO_UPLOAD_SECRET = "test-upload-secret";
process.env.CLOUD_PUBLIC_HOST_NAME = "test.example.com";

// Stub R2 storage so tests are offline and deterministic.
const putPhoto = mock(async (_p: unknown) => ({ key: "sdk_photos/u/r-1.jpg", sizeBytes: 1234 }));
const getSignedDownloadUrl = mock(async (_k: string, _ttl?: number) => "https://r2.example/signed");

mock.module("../../../../services/storage/miniapp-sdk-photo-storage.service", () => ({
  miniappSdkPhotoStorage: {
    putPhoto,
    getSignedDownloadUrl,
  },
}));

const stubLogger: any = {
  error: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  info: () => undefined,
};
stubLogger.child = () => stubLogger;

mock.module("../../../../services/logging/pino-logger", () => ({
  logger: stubLogger,
  default: stubLogger,
}));

mock.module("../../../../services/logging", () => ({
  logger: stubLogger,
  default: stubLogger,
}));

const { default: app, __testing__ } = await import("./photo.api");

function authHeader(email = "alex@example.com"): Record<string, string> {
  const token = jwt.sign({ email }, "test-secret");
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

function uploadAuth(userId = "alex@example.com", overrides: Partial<{ purpose: string }> = {}) {
  const token = jwt.sign(
    { userId, purpose: overrides.purpose ?? "v2_photo_upload" },
    "test-upload-secret",
    { expiresIn: 120 },
  );
  return `Bearer ${token}`;
}

function multipartBody(content: string, mimeType = "image/jpeg"): { body: FormData } {
  const form = new FormData();
  form.append("photo", new Blob([content], { type: mimeType }), "test.jpg");
  return { body: form };
}

describe("v2 photo API", () => {
  beforeEach(() => {
    __testing__.clearAll();
    putPhoto.mockClear();
    getSignedDownloadUrl.mockClear();
    putPhoto.mockResolvedValue({ key: "sdk_photos/u/r-1.jpg", sizeBytes: 1234 });
    getSignedDownloadUrl.mockResolvedValue("https://r2.example/signed");
  });

  describe("POST /request", () => {
    test("rejects without a bearer JWT (401)", async () => {
      const res = await app.request("http://x/request", { method: "POST" });
      expect(res.status).toBe(401);
    });

    test("returns {requestId, uploadUrl, uploadToken}; token is signed with the upload secret and has photo-agnostic payload", async () => {
      const res = await app.request("http://x/request", {
        method: "POST",
        headers: authHeader(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        requestId: string;
        uploadUrl: string;
        uploadToken: string;
      };
      expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(body.uploadUrl).toBe(
        `https://test.example.com/api/v2/client/photo/upload/${body.requestId}`,
      );
      const decoded = jwt.verify(body.uploadToken, "test-upload-secret") as Record<
        string,
        unknown
      >;
      expect(decoded.userId).toBe("alex@example.com");
      expect(decoded.purpose).toBe("v2_photo_upload");
      // requestId is intentionally NOT in the token payload (capability semantics).
      expect(decoded.requestId).toBeUndefined();
    });

    test("registers slot as pending in the in-memory map", async () => {
      const res = await app.request("http://x/request", {
        method: "POST",
        headers: authHeader(),
      });
      const { requestId } = (await res.json()) as { requestId: string };
      const state = __testing__.photos.get(requestId);
      expect(state?.kind).toBe("pending");
    });

    test("fails closed when the upload signing secret is missing", async () => {
      const prev = process.env.MENTRA_PHOTO_UPLOAD_SECRET;
      delete process.env.MENTRA_PHOTO_UPLOAD_SECRET;
      try {
        const res = await app.request("http://x/request", {
          method: "POST",
          headers: authHeader(),
        });
        expect(res.status).toBe(503);
        const json = (await res.json()) as { code: string };
        expect(json.code).toBe("upload_secret_missing");
      } finally {
        process.env.MENTRA_PHOTO_UPLOAD_SECRET = prev;
      }
    });
  });

  describe("POST /upload/:requestId", () => {
    async function provision(email = "alex@example.com"): Promise<string> {
      const res = await app.request("http://x/request", {
        method: "POST",
        headers: authHeader(email),
      });
      const { requestId } = (await res.json()) as { requestId: string };
      return requestId;
    }

    test("happy path: stores via R2, transitions slot to ready, returns ok", async () => {
      const requestId = await provision();
      const { body } = multipartBody("fake-jpeg-bytes");
      const res = await app.request(`http://x/upload/${requestId}`, {
        method: "POST",
        headers: { authorization: uploadAuth() },
        body,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(putPhoto).toHaveBeenCalledTimes(1);
      const state = __testing__.photos.get(requestId);
      expect(state?.kind).toBe("ready");
      if (state?.kind === "ready") {
        expect(state.photoUrl).toBe("https://r2.example/signed");
      }
    });

    test("rejects expired JWT (401)", async () => {
      const requestId = await provision();
      const expired = jwt.sign(
        { userId: "alex@example.com", purpose: "v2_photo_upload" },
        "test-upload-secret",
        { expiresIn: -1 },
      );
      const { body } = multipartBody("x");
      const res = await app.request(`http://x/upload/${requestId}`, {
        method: "POST",
        headers: { authorization: `Bearer ${expired}` },
        body,
      });
      expect(res.status).toBe(401);
      expect(putPhoto).not.toHaveBeenCalled();
    });

    test("rejects token signed by a different secret (401)", async () => {
      const requestId = await provision();
      const bad = jwt.sign(
        { userId: "alex@example.com", purpose: "v2_photo_upload" },
        "wrong-secret",
      );
      const { body } = multipartBody("x");
      const res = await app.request(`http://x/upload/${requestId}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bad}` },
        body,
      });
      expect(res.status).toBe(401);
    });

    test("rejects JWT with wrong purpose (401)", async () => {
      const requestId = await provision();
      const { body } = multipartBody("x");
      const res = await app.request(`http://x/upload/${requestId}`, {
        method: "POST",
        headers: { authorization: uploadAuth("alex@example.com", { purpose: "something_else" }) },
        body,
      });
      expect(res.status).toBe(401);
    });

    test("returns 404 when no slot exists for the URL requestId", async () => {
      const { body } = multipartBody("x");
      const res = await app.request("http://x/upload/no-such-slot", {
        method: "POST",
        headers: { authorization: uploadAuth() },
        body,
      });
      expect(res.status).toBe(404);
    });

    test("returns 404 when caller is not the owner of the slot (don't leak existence)", async () => {
      const requestId = await provision("alex@example.com");
      const { body } = multipartBody("x");
      const res = await app.request(`http://x/upload/${requestId}`, {
        method: "POST",
        headers: { authorization: uploadAuth("eve@evil.com") },
        body,
      });
      expect(res.status).toBe(404);
      expect(putPhoto).not.toHaveBeenCalled();
    });

    test("rejects re-upload to an already-ready slot (409)", async () => {
      const requestId = await provision();
      const { body: body1 } = multipartBody("first");
      await app.request(`http://x/upload/${requestId}`, {
        method: "POST",
        headers: { authorization: uploadAuth() },
        body: body1,
      });
      const { body: body2 } = multipartBody("second");
      const res = await app.request(`http://x/upload/${requestId}`, {
        method: "POST",
        headers: { authorization: uploadAuth() },
        body: body2,
      });
      expect(res.status).toBe(409);
      expect(putPhoto).toHaveBeenCalledTimes(1); // not called for the second upload
    });

    test("rejects multipart missing photo field (400)", async () => {
      const requestId = await provision();
      const form = new FormData();
      form.append("not_photo", new Blob(["x"]));
      const res = await app.request(`http://x/upload/${requestId}`, {
        method: "POST",
        headers: { authorization: uploadAuth() },
        body: form,
      });
      expect(res.status).toBe(400);
    });

    test("rejects multipart photo field that is not a file (400)", async () => {
      const requestId = await provision();
      const form = new FormData();
      form.append("photo", "not-a-file");
      const res = await app.request(`http://x/upload/${requestId}`, {
        method: "POST",
        headers: { authorization: uploadAuth() },
        body: form,
      });
      expect(res.status).toBe(400);
      expect(putPhoto).not.toHaveBeenCalled();
    });

    test("fails closed when the upload verification secret is missing", async () => {
      const requestId = await provision();
      const prev = process.env.MENTRA_PHOTO_UPLOAD_SECRET;
      delete process.env.MENTRA_PHOTO_UPLOAD_SECRET;
      try {
        const { body } = multipartBody("x");
        const res = await app.request(`http://x/upload/${requestId}`, {
          method: "POST",
          headers: { authorization: uploadAuth() },
          body,
        });
        expect(res.status).toBe(503);
        const json = (await res.json()) as { code: string };
        expect(json.code).toBe("upload_secret_missing");
        expect(putPhoto).not.toHaveBeenCalled();
      } finally {
        process.env.MENTRA_PHOTO_UPLOAD_SECRET = prev;
      }
    });

    test("returns 503 storage_unavailable when R2 throws not-configured", async () => {
      const requestId = await provision();
      putPhoto.mockRejectedValueOnce(
        new Error("R2 not configured — miniapp SDK photo storage unavailable"),
      );
      const { body } = multipartBody("x");
      const res = await app.request(`http://x/upload/${requestId}`, {
        method: "POST",
        headers: { authorization: uploadAuth() },
        body,
      });
      expect(res.status).toBe(503);
      const json = (await res.json()) as { code: string };
      expect(json.code).toBe("storage_unavailable");
      // The slot should transition to error so the long-poll also fails fast.
      const state = __testing__.photos.get(requestId);
      expect(state?.kind).toBe("error");
    });
  });

  describe("GET /:requestId", () => {
    test("returns 404 for unknown requestId", async () => {
      const res = await app.request("http://x/nope", { headers: authHeader() });
      expect(res.status).toBe(404);
    });

    test("returns 404 for another user's requestId (no existence leak)", async () => {
      const res1 = await app.request("http://x/request", {
        method: "POST",
        headers: authHeader("alex@example.com"),
      });
      const { requestId } = (await res1.json()) as { requestId: string };
      const res2 = await app.request(`http://x/${requestId}`, {
        headers: authHeader("eve@evil.com"),
      });
      expect(res2.status).toBe(404);
    });

    test("returns ready entry immediately when upload already arrived", async () => {
      const r1 = await app.request("http://x/request", {
        method: "POST",
        headers: authHeader(),
      });
      const { requestId } = (await r1.json()) as { requestId: string };
      const { body } = multipartBody("x");
      await app.request(`http://x/upload/${requestId}`, {
        method: "POST",
        headers: { authorization: uploadAuth() },
        body,
      });
      const res = await app.request(`http://x/${requestId}`, { headers: authHeader() });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { photoUrl: string; size: number };
      expect(json.photoUrl).toBe("https://r2.example/signed");
      expect(json.size).toBe(1234);
    });

    test("long-poll resolves when /upload arrives mid-flight", async () => {
      const r1 = await app.request("http://x/request", {
        method: "POST",
        headers: authHeader(),
      });
      const { requestId } = (await r1.json()) as { requestId: string };
      // Kick off the long-poll first.
      const pollP = app.request(`http://x/${requestId}`, { headers: authHeader() });
      // Then fire the upload after a short delay.
      setTimeout(async () => {
        const { body } = multipartBody("late");
        await app.request(`http://x/upload/${requestId}`, {
          method: "POST",
          headers: { authorization: uploadAuth() },
          body,
        });
      }, 50);
      const res = await pollP;
      expect(res.status).toBe(200);
      const json = (await res.json()) as { photoUrl: string };
      expect(json.photoUrl).toBe("https://r2.example/signed");
    });

    test("returns 502 with error code/message when upload errored (e.g. storage_unavailable)", async () => {
      const r1 = await app.request("http://x/request", {
        method: "POST",
        headers: authHeader(),
      });
      const { requestId } = (await r1.json()) as { requestId: string };
      putPhoto.mockRejectedValueOnce(new Error("R2 not configured X"));
      const { body } = multipartBody("x");
      await app.request(`http://x/upload/${requestId}`, {
        method: "POST",
        headers: { authorization: uploadAuth() },
        body,
      });
      const res = await app.request(`http://x/${requestId}`, { headers: authHeader() });
      expect(res.status).toBe(502);
      const json = (await res.json()) as { code: string };
      expect(json.code).toBe("storage_unavailable");
    });
  });

  describe("DELETE /:requestId", () => {
    test("removes the slot for the owner", async () => {
      const r1 = await app.request("http://x/request", {
        method: "POST",
        headers: authHeader(),
      });
      const { requestId } = (await r1.json()) as { requestId: string };
      const res = await app.request(`http://x/${requestId}`, {
        method: "DELETE",
        headers: authHeader(),
      });
      expect(res.status).toBe(200);
      expect(__testing__.photos.has(requestId)).toBe(false);
    });

    test("idempotent — deleting a nonexistent slot still 200s", async () => {
      const res = await app.request("http://x/nope", {
        method: "DELETE",
        headers: authHeader(),
      });
      expect(res.status).toBe(200);
    });

    test("returns 200 without deleting when caller is not the owner (probe defense)", async () => {
      const r1 = await app.request("http://x/request", {
        method: "POST",
        headers: authHeader("alex@example.com"),
      });
      const { requestId } = (await r1.json()) as { requestId: string };
      const res = await app.request(`http://x/${requestId}`, {
        method: "DELETE",
        headers: authHeader("eve@evil.com"),
      });
      // Defense against probes: identical 200 response shape for
      // "doesn't exist" and "not yours". Slot remains untouched.
      expect(res.status).toBe(200);
      expect(__testing__.photos.has(requestId)).toBe(true);
    });
  });
});
