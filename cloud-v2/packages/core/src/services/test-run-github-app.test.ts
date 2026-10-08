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
  expect(await app.token("reporter")).toBe("scoped-3");
  expect(bodies).toEqual([
    { repositories: ["MentraOS"], permissions: { actions: "write", contents: "read", pull_requests: "read" } },
    { repositories: ["Mentra-Automated-Testing"], permissions: { actions: "read" } },
    { repositories: ["MentraOS"], permissions: { pull_requests: "write" } },
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

test("runner credentials request only the runner grant and share the existing refresh with exact expiry", async () => {
  let now = start, issued = 0;
  const bodies: unknown[] = [];
  const app = new TestRunGithubApp({credentials, now: () => now, fetch: async (_url, init) => {
    issued++; bodies.push(JSON.parse(String(init.body)));
    return Response.json({token: `runner-${issued}`, expires_at: new Date(now + 3600_000).toISOString()}, {status: 201});
  }});
  const initial = {credential: "runner-1", expiresAt: new Date(start + 3600_000).toISOString()};
  expect(await Promise.all(Array.from({length: 10}, () => app.runnerCredential()))).toEqual(Array(10).fill(initial));
  expect(bodies).toEqual([{repositories: ["Mentra-Automated-Testing"], permissions: {self_hosted_runners: "write"}}]);
  expect(await app.token("runner")).toBe("runner-1");
  now += 58 * 60_000; expect(await app.runnerCredential()).toEqual(initial); expect(issued).toBe(1);
  now += 60_000;
  const refreshed = {credential: "runner-2", expiresAt: new Date(now + 3600_000).toISOString()};
  expect(await Promise.all(Array.from({length: 10}, () => app.runnerCredential()))).toEqual(Array(10).fill(refreshed));
  expect(issued).toBe(2);
});

test("runner refresh failure exposes neither the key nor provider credential and recovers on retry", async () => {
  let calls = 0;
  const app = new TestRunGithubApp({credentials, now: () => start, fetch: async () => {
    calls++;
    return calls === 1 ? Response.json({token: "private-provider-data"}, {status: 403})
      : Response.json({token: "recovered-runner", expires_at: new Date(start + 3600_000).toISOString()}, {status: 201});
  }});
  await expect(app.runnerCredential()).rejects.toThrow("GitHub App installation authentication is unavailable");
  expect(await app.runnerCredential()).toEqual({credential: "recovered-runner", expiresAt: new Date(start + 3600_000).toISOString()});
  expect(calls).toBe(2);
});
