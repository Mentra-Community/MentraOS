/**
 * Test: Kill Session via API
 *
 * Calls POST /api/debug/kill-session against the running dev server.
 * Assumes the dev server is running (bun run dev) and the user is
 * logged in.
 *
 * The endpoint requires auth (every protected route does), so we
 * mint a frontend token with the dev API key and send it as a
 * bearer header. The handler reads the user id from the
 * authenticated context, not from the request.
 *
 * Run: bun run test:disconnect
 */

import { describe, test, expect } from "bun:test";
import { generateFrontendToken } from "@mentra/sdk";

const BASE_URL = "http://localhost:3000";
const USER_ID = "fparyan28@gmail.com";
const API_KEY = process.env.MENTRAOS_API_KEY;

if (!API_KEY) {
  throw new Error(
    "MENTRAOS_API_KEY must be set (the test mints a frontend token to authenticate against the dev server). Run with `MENTRAOS_API_KEY=$(grep MENTRAOS_API_KEY .env | cut -d= -f2) bun run test:disconnect`.",
  );
}

const token = generateFrontendToken(USER_ID, API_KEY);

describe("kill session via API", () => {
  test(`kills session for ${USER_ID}`, async () => {
    const res = await fetch(`${BASE_URL}/api/debug/kill-session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await res.json();
    console.log(`Status: ${res.status}`, data);

    // 200 = session existed and was killed
    // 404 = no session for this user (glasses not connected)
    expect([200, 404]).toContain(res.status);

    if (res.status === 200) {
      expect(data.success).toBe(true);
      console.log("Session killed successfully");
    } else {
      console.log("No active session to kill (glasses not connected)");
    }
  });
});
