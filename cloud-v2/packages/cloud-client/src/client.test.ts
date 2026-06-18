import { describe, expect, test } from "bun:test";

import { CloudClient } from "./client";
import { AuthExpiredError, CloudClientError } from "./errors";
import type { CloudClientConfig } from "./config";
import type { CloudClientTransports, WebSocketLike } from "./transports";

describe("CloudClient construction", () => {
  test("rejects Core auth without a Core endpoint", () => {
    expect(() =>
      new CloudClient(
        config({
          endpoints: { runtime: "https://runtime.example.test" },
          auth: {
            core: { subjectToken: "subject", subjectTokenType: "oem-jwt" },
            runtime: { getToken: async () => "runtime-token" },
          },
        }),
      ),
    ).toThrow(CloudClientError);
    expect(() =>
      new CloudClient(
        config({
          endpoints: { runtime: "https://runtime.example.test" },
          auth: {
            core: { subjectToken: "subject", subjectTokenType: "oem-jwt" },
            runtime: { getToken: async () => "runtime-token" },
          },
        }),
      ),
    ).toThrow("auth.core requires endpoints.core");
  });

  test("rejects Core-brokered Runtime auth without Core auth and endpoint", () => {
    expect(() =>
      new CloudClient(
        config({
          endpoints: { runtime: "https://runtime.example.test" },
          auth: { runtime: { source: "core" } },
        }),
      ),
    ).toThrow("auth.runtime.source='core' requires endpoints.core and auth.core");
  });

  test("constructs runtime-only clients without Core identity or miniapp auto-auth", async () => {
    const cloud = new CloudClient(
      config({
        endpoints: { runtime: "https://runtime.example.test" },
        auth: { runtime: { getToken: async () => "runtime-token" } },
      }),
    );

    expect(cloud.core).toBeUndefined();
    expect(() => cloud.auth.identity).toThrow(AuthExpiredError);
    expect(() => cloud.auth.identity).toThrow("runtime-only mode");
    await expect(cloud.auth.getMiniappToken("com.example.app")).rejects.toThrow(
      "runtime-only mode",
    );
  });

  test("remints miniapp tokens when requested TTL exceeds cached lifetime", async () => {
    const originalFetch = globalThis.fetch;
    const nowSeconds = Math.floor(Date.now() / 1000);
    let miniappMints = 0;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/client/auth/refresh")) {
        return jsonResponse({
          access_token: testJwt({ sub: "user-1", oem_id: "oem-1", exp: nowSeconds + 3600 }),
          refresh_token: "refresh-2",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (url.endsWith("/api/client/auth/miniapp-token")) {
        miniappMints += 1;
        return jsonResponse({
          token: `miniapp-${miniappMints}`,
          expiresAt: miniappMints === 1 ? nowSeconds + 180 : nowSeconds + 3600,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const cloud = new CloudClient(
        config({
          endpoints: { core: "https://core.example.test", runtime: "https://runtime.example.test" },
          auth: {
            core: {
              accessToken: testJwt({ sub: "user-1", oem_id: "oem-1", exp: nowSeconds + 3600 }),
              refreshToken: "refresh-1",
            },
            runtime: { getToken: async () => "runtime-token" },
          },
        }),
      );

      await expect(cloud.auth.getMiniappToken("com.example.app")).resolves.toMatchObject({
        token: "miniapp-1",
      });
      await expect(cloud.auth.getMiniappToken("com.example.app")).resolves.toMatchObject({
        token: "miniapp-1",
      });
      await expect(
        cloud.auth.getMiniappToken("com.example.app", { minTtlMs: 5 * 60 * 1000 }),
      ).resolves.toMatchObject({
        token: "miniapp-2",
      });
      expect(miniappMints).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function config(
  overrides: Pick<CloudClientConfig, "endpoints" | "auth">,
): CloudClientConfig {
  return {
    ...overrides,
    transports: dummyTransports(),
  };
}

function dummyTransports(): CloudClientTransports {
  return {
    ws: () => dummyWs(),
    udp: () => ({
      send: () => undefined,
      onMessage: () => undefined,
      close: () => undefined,
    }),
    storage: {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
    },
  };
}

function dummyWs(): WebSocketLike {
  return {
    send: () => undefined,
    sendBinary: () => undefined,
    close: () => undefined,
    onOpen: () => undefined,
    onMessage: () => undefined,
    onClose: () => undefined,
    onError: () => undefined,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function testJwt(claims: Record<string, unknown>): string {
  return [
    base64UrlJson({ alg: "none", typ: "JWT" }),
    base64UrlJson(claims),
    "signature",
  ].join(".");
}

function base64UrlJson(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
