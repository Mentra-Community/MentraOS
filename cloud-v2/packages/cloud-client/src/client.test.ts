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
