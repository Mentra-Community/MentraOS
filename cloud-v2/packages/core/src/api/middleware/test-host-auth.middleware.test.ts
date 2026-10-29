import {expect, test} from "bun:test";
import {Hono} from "hono";
import {createTestHostAuth, type TestHostEnv} from "./test-host-auth.middleware";

function app(config: string | undefined) {
  const api = new Hono<TestHostEnv>();
  api.use("*", createTestHostAuth(() => config));
  api.get("/", c => c.json({hostId: c.var.testHostId}));
  return api;
}

test("host identity comes from the credential, never query input", async () => {
  const token = "synthetic-controller-credential-" + "a".repeat(32);
  const api = app(JSON.stringify({mini: token, other: "b".repeat(64)}));
  const response = await api.request("/?hostId=other", {headers: {authorization: `Bearer ${token}`}});
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({hostId: "mini"});
  expect((await api.request("/", {headers: {authorization: "Bearer invalid"}})).status).toBe(401);
});

test("missing, malformed and ambiguous host credentials refuse admission", async () => {
  for (const config of [undefined, "invalid", "[]", "{}", JSON.stringify({mini: "short"}),
    JSON.stringify({mini: "a".repeat(64), other: "a".repeat(64)})]) {
    expect((await app(config).request("/", {headers: {authorization: `Bearer ${"a".repeat(64)}`}})).status).toBe(503);
  }
});
