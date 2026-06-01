import { describe, expect, test } from "bun:test";

import { resolveAppApiKeyCredentials } from "./auth.utils";

describe("resolveAppApiKeyCredentials", () => {
  test("accepts packageName-prefixed bearer tokens", () => {
    expect(resolveAppApiKeyCredentials("Bearer com.example.app:secret-key")).toEqual({
      credentials: {
        packageName: "com.example.app",
        apiKey: "secret-key",
      },
    });
  });

  test("accepts legacy bearer tokens when packageName is provided in the body", () => {
    expect(resolveAppApiKeyCredentials("Bearer secret-key", "com.example.app")).toEqual({
      credentials: {
        packageName: "com.example.app",
        apiKey: "secret-key",
      },
    });
  });

  test("rejects mismatched package names between header and body", () => {
    expect(resolveAppApiKeyCredentials("Bearer com.example.app:secret-key", "com.other.app")).toEqual({
      error: "Invalid credentials",
    });
  });

  test("rejects legacy bearer tokens without a fallback package name", () => {
    expect(resolveAppApiKeyCredentials("Bearer secret-key")).toEqual({
      error: "Invalid token format",
    });
  });

  test("rejects malformed multi-part tokens", () => {
    expect(resolveAppApiKeyCredentials("Bearer com.example.app:secret-key:extra")).toEqual({
      error: "Invalid token format",
    });
  });
});
