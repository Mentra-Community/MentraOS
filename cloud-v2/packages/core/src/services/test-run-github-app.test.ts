import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { jwtVerify } from "jose";
import { TestRunGithubApp } from "./test-run-github-app";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const credentials = { appId: "12345", installationId: "67890", privateKey: privateKey.export({ format: "pem", type: "pkcs1" }).toString() };
const start = Date.parse("2026-09-23T12:00:00Z");

test("installation tokens use signed short-lived JWTs and explicit separate repository permissions", async () => {
  const bodies: unknown[] = [], app = new TestRunGithubApp({ credentials, now: () => start, fetch: async (url, init) => {
    expect(url).toBe("https://api.github.com/app/installations/67890/access_tokens");
    expect(init?.method).toBe("POST"); expect(init?.redirect).toBe("error");
    const bearer = new Headers(init?.headers).get("Authorization")!;
    const verified = await jwtVerify(bearer.slice("Bearer ".length), publicKey, {
      issuer: credentials.appId, algorithms: ["RS256"], currentDate: new Date(start),
    });
    expect(verified.payload.iat).toBe(start / 1000 - 60); expect(verified.payload.exp).toBe(start / 1000 + 540);
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ token: `scoped-${bodies.length}`, expires_at: new Date(start + 3600_000).toISOString() }, { status: 201 });
  } });
  expect(await app.token("source")).toBe("scoped-1"); expect(await app.token("private")).toBe("scoped-2");
  expect(bodies).toEqual([
    { repositories: ["MentraOS"], permissions: { actions: "write", contents: "read", pull_requests: "read" } },
    { repositories: ["Mentra-Automated-Testing"], permissions: { actions: "read" } },
  ]);
});

test("concurrent readers share one refresh and cached credentials refresh before expiration", async () => {
  let now = start, issued = 0;
  const app = new TestRunGithubApp({ credentials, now: () => now, fetch: async () => {
    issued++;
    return Response.json({ token: `token-${issued}`, expires_at: new Date(now + 3600_000).toISOString() }, { status: 201 });
  } });
  expect(await Promise.all(Array.from({ length: 10 }, () => app.token("source")))).toEqual(Array(10).fill("token-1"));
  now += 58 * 60_000;
  expect(await app.token("source")).toBe("token-1"); expect(issued).toBe(1);
  now += 60_000;
  expect(await Promise.all(Array.from({ length: 10 }, () => app.token("source")))).toEqual(Array(10).fill("token-2"));
  expect(issued).toBe(2);
  expect(await app.token("private")).toBe("token-3");
  expect(await app.token("source")).toBe("token-2");
});

test("failed refreshes are sanitized and can recover without retaining a rejected promise", async () => {
  for (const failure of [new Error("secret-transport-data"), Response.json({ token: "secret-response-data" }, { status: 403 }),
    Response.json({ token: "secret-response-data", expires_at: "bad-date" }, { status: 201 }),
    Response.json({ token: "secret-response-data", expires_at: new Date(start + 30_000).toISOString() }, { status: 201 })]) {
    let calls = 0;
    const app = new TestRunGithubApp({ credentials, now: () => start, fetch: async () => {
      calls++;
      if (calls > 1) return Response.json({ token: "recovered", expires_at: new Date(start + 3600_000).toISOString() }, { status: 201 });
      if (failure instanceof Error) throw failure;
      return failure;
    } });
    await expect(app.token("source")).rejects.toThrow("GitHub App installation authentication is unavailable");
    expect(await app.token("source")).toBe("recovered"); expect(calls).toBe(2);
  }
});

test("invalid configuration cannot contact GitHub and key errors never expose key material", async () => {
  for (const value of [{}, { ...credentials, installationId: "../other" }, { ...credentials, privateKey: "secret-invalid-key" }]) {
    let calls = 0;
    const app = new TestRunGithubApp({ credentials: value, fetch: async () => { calls++; throw new Error("Must not send"); } });
    let error: unknown;
    try { await app.token("source"); } catch (failure) { error = failure; }
    expect((error as Error).message).toBe("GitHub App installation authentication is unavailable");
    expect(calls).toBe(0);
  }
});
