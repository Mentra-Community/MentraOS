import { beforeEach, describe, expect, mock, test } from "bun:test";

const validateApiKey = mock(async () => true);
const exchangeTemporaryToken = mock(async () => ({
  success: true as const,
  userId: "user@example.com",
}));

mock.module("../../../services/sdk/sdk.auth.service", () => ({
  validateApiKey,
}));

mock.module("../../../services/core/temp-token.service", () => ({
  tokenService: {
    exchangeTemporaryToken,
    generateTemporaryToken: mock(async () => "temp-token"),
    issueUserToken: mock(async () => "signed-token"),
  },
}));

mock.module("../../../services/core/app.service", () => ({
  default: {
    hashWithApiKey: mock(async () => "hash"),
  },
}));

mock.module("../../../services/logging/pino-logger", () => ({
  logger: {
    child: () => ({
      error: mock(() => undefined),
      debug: mock(() => undefined),
      warn: mock(() => undefined),
      info: mock(() => undefined),
    }),
  },
}));

const { default: app } = await import("./auth.routes");

describe("POST /exchange-user-token", () => {
  beforeEach(() => {
    validateApiKey.mockReset();
    validateApiKey.mockResolvedValue(true);

    exchangeTemporaryToken.mockReset();
    exchangeTemporaryToken.mockResolvedValue({
      success: true as const,
      userId: "user@example.com",
    });
  });

  test("accepts legacy bearer tokens when packageName is provided in the JSON body", async () => {
    const response = await app.request("http://localhost/exchange-user-token", {
      method: "POST",
      headers: {
        "authorization": "Bearer secret-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        aos_temp_token: "temp-token",
        packageName: "com.example.app",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      userId: "user@example.com",
    });
    expect(validateApiKey).toHaveBeenCalledWith("com.example.app", "secret-key");
    expect(exchangeTemporaryToken).toHaveBeenCalledWith("temp-token", "com.example.app");
  });

  test("rejects packageName mismatches between the bearer token and request body", async () => {
    const response = await app.request("http://localhost/exchange-user-token", {
      method: "POST",
      headers: {
        "authorization": "Bearer com.example.app:secret-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        aos_temp_token: "temp-token",
        packageName: "com.other.app",
      }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Invalid credentials",
    });
    expect(exchangeTemporaryToken).not.toHaveBeenCalled();
  });

  test.each([
    {
      reason: "token_not_found" as const,
      message: "Temporary token not found",
      status: 401,
    },
    {
      reason: "token_used" as const,
      message: "Temporary token already used",
      status: 401,
    },
    {
      reason: "token_expired" as const,
      message: "Temporary token expired",
      status: 401,
    },
    {
      reason: "token_package_mismatch" as const,
      message: "Temporary token was issued for a different app",
      status: 401,
    },
    {
      reason: "exchange_error" as const,
      message: "Failed to exchange token",
      status: 500,
    },
  ])("surfaces $reason with status $status and a stable code", async ({ reason, message, status }) => {
    exchangeTemporaryToken.mockResolvedValue({ success: false, reason });

    const response = await app.request("http://localhost/exchange-user-token", {
      method: "POST",
      headers: {
        "authorization": "Bearer com.example.app:secret-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        aos_temp_token: "temp-token",
        packageName: "com.example.app",
      }),
    });

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      success: false,
      code: reason,
      error: message,
    });
  });
});
