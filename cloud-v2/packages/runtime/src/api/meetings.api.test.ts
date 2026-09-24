import crypto from "node:crypto"
import {afterAll, beforeAll, describe, expect, test} from "bun:test"
import {Hono} from "hono"
import {resetRuntimeAuthCache, signRuntimeToken} from "@mentra/cloud-shared"

import {meetingsApi} from "./meetings.api"
import {resetTeamsMeetingStateForTests} from "../services/meetings/teams-meetings.service"
import {
  resetAcsTeamsAuthCache,
  setAcsIdentityClientForTests,
  type AcsIdentityClient,
} from "../services/meetings/acs-teams.service"

const ISSUER = "https://core.private-test.example"
const savedEnv = new Map<string, string | undefined>()
let privateKey: string

describe("Runtime ACS credential API", () => {
  beforeAll(() => {
    const keys = crypto.generateKeyPairSync("ed25519")
    privateKey = stripPem(keys.privateKey.export({type: "pkcs8", format: "pem"}).toString())
    const publicKey = stripPem(keys.publicKey.export({type: "spki", format: "pem"}).toString())
    setEnv(
      "CLOUD_RUNTIME_AUTH_ISSUERS",
      JSON.stringify([
        {
          issuer: ISSUER,
          publicKey,
          userIdClaim: "sub",
          tenantIdClaim: "tenant_id",
          algorithms: ["EdDSA"],
        },
      ]),
    )
    setEnv("CLOUD_RUNTIME_AUTH_AUDIENCE", "cloud-runtime")
    setEnv("ACS_CONNECTION_STRING", "endpoint=https://test.communication.azure.com/;accesskey=test")
    deleteEnv("ENTRA_TENANT_ID")
    deleteEnv("ENTRA_CLIENT_ID")
    resetRuntimeAuthCache()
    setAcsIdentityClientForTests({
      async createUserAndToken() {
        return {
          token: "guest-token",
          expiresOn: new Date("2030-01-01T00:00:00.000Z"),
          user: {communicationUserId: "guest-user"},
        }
      },
      async getTokenForTeamsUser() {
        throw new Error("not used")
      },
    } satisfies AcsIdentityClient)
  })

  afterAll(() => {
    resetAcsTeamsAuthCache()
    resetRuntimeAuthCache()
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  test("requires Runtime authentication", async () => {
    expect((await app().request("/api/meetings/acs/token", {method: "POST"})).status).toBe(401)
  })

  test("creation and retirement require Runtime authentication", async () => {
    for (const path of ["create", "retire"]) {
      expect((await app().request(`/api/meetings/teams/${path}`, {method: "POST"})).status).toBe(401)
    }
  })

  test("rejects organizer injection, malformed input and unbound employee tokens", async () => {
    const headers = {"authorization": `Bearer ${await runtimeToken()}`, "content-type": "application/json"}
    for (const body of ["{", JSON.stringify({organizerId: "victim"}), JSON.stringify({durationMinutes: 0})]) {
      expect((await app().request("/api/meetings/teams/create", {method: "POST", headers, body})).status).toBe(400)
    }
    expect(
      (
        await app().request("/api/meetings/teams/create", {
          method: "POST",
          headers,
          body: JSON.stringify({teamsUserAadToken: "x".repeat(100)}),
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await app().request("/api/meetings/teams/create", {
          method: "POST",
          headers,
          body: "x".repeat(17 * 1024),
        })
      ).status,
    ).toBe(413)
  })

  test("creates using the fallback organizer and binds retirement to the authenticated caller", async () => {
    setEnv("TEAMS_GRAPH_TENANT_ID", "tenant")
    setEnv("TEAMS_GRAPH_CLIENT_ID", "graph-app")
    setEnv("TEAMS_GRAPH_CLIENT_SECRET", "graph-secret")
    setEnv("TEAMS_GRAPH_ORGANIZER_ID", "fallback-organizer")
    resetTeamsMeetingStateForTests()
    const savedFetch = globalThis.fetch
    const deleted: string[] = []
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("/oauth2/v2.0/token"))
        return Response.json({access_token: "graph-token", expires_in: 3600})
      if (init?.method === "DELETE") {
        deleted.push(String(input))
        return new Response(null, {status: 204})
      }
      return Response.json({id: "meeting", joinWebUrl: "https://teams.microsoft.com/meet/123456"})
    }) as typeof fetch
    try {
      const headers = {"authorization": `Bearer ${await runtimeToken()}`, "content-type": "application/json"}
      const response = await app().request("/api/meetings/teams/create", {
        method: "POST",
        headers,
        body: JSON.stringify({subject: "Standup"}),
      })
      expect(response.status).toBe(200)
      const result = (await response.json()) as {meetingRef: string}
      expect(result).toMatchObject({identityMode: "guest", guestReason: "no-entra-identity"})
      expect(result).not.toHaveProperty("token")
      const body = JSON.stringify({meetingRef: result.meetingRef})
      expect(
        (
          await app().request("/api/meetings/teams/retire", {
            method: "POST",
            headers: {...headers, authorization: `Bearer ${await runtimeToken("other-user")}`},
            body,
          })
        ).status,
      ).toBe(403)
      expect(deleted).toHaveLength(0)
      expect((await app().request("/api/meetings/teams/retire", {method: "POST", headers, body})).status).toBe(200)
      expect(deleted).toEqual(["https://graph.microsoft.com/v1.0/users/fallback-organizer/onlineMeetings/meeting"])
    } finally {
      globalThis.fetch = savedFetch
      resetTeamsMeetingStateForTests()
    }
  })

  test("explains missing Graph configuration to clients without exposing provider secrets", async () => {
    deleteEnv("TEAMS_GRAPH_CLIENT_ID")
    const response = await app().request("/api/meetings/teams/create", {
      method: "POST",
      headers: {authorization: `Bearer ${await runtimeToken()}`},
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: "Teams meeting creation is not configured on this Runtime",
      message: "Teams meeting creation is not configured on this Runtime",
    })
  })

  test("issues a guest credential without requiring Entra configuration", async () => {
    const response = await app().request("/api/meetings/acs/token", {
      method: "POST",
      headers: {authorization: `Bearer ${await runtimeToken()}`},
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      token: "guest-token",
      expiresOn: "2030-01-01T00:00:00.000Z",
      identityMode: "guest",
      acsUserId: "guest-user",
    })
  })

  test.each(["acs/token", "teams/create"])("explains identity rejection without guest fallback on %s", async (path) => {
    const response = await app().request(`/api/meetings/${path}`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${await runtimeToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({teamsUserAadToken: "x".repeat(100)}),
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: "Teams identity exchange rejected",
      message: "Teams identity exchange rejected",
    })
  })

  test("an opaque token is checked against the signed Runtime identity by ACS", async () => {
    setEnv("ENTRA_TENANT_ID", "entra-tenant")
    setEnv("ENTRA_CLIENT_ID", "mobile-client")
    let calls = 0
    let rejected = false
    setAcsIdentityClientForTests({
      async createUserAndToken() {
        throw new Error("must not downgrade")
      },
      async getTokenForTeamsUser(input) {
        calls++
        expect(input).toEqual({
          teamsUserAadToken: "opaque".repeat(25),
          clientId: "mobile-client",
          userObjectId: "employee",
        })
        if (rejected) throw {statusCode: 403, code: "UserObjectIdMismatch", request: {body: "private"}}
        return {token: "teams-credential", expiresOn: new Date("2030-01-01")}
      },
    })
    const token = await signRuntimeToken({
      privateKey,
      issuer: ISSUER,
      subject: "user-1",
      tenantId: "tenant-1",
      expiresInSeconds: 300,
      federatedIdentity: {
        providerId: "workforce",
        providerKind: "microsoft-entra",
        issuer: "https://login.microsoftonline.com/entra-tenant/v2.0",
        directoryTenantId: "entra-tenant",
        subject: "employee",
      },
    })
    const request = () =>
      app().request("/api/meetings/acs/token", {
        method: "POST",
        headers: {authorization: `Bearer ${token}`},
        body: JSON.stringify({teamsUserAadToken: "opaque".repeat(25)}),
      })
    const response = await request()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({identityMode: "teams-user"})
    rejected = true
    const denied = await request()
    expect(denied.status).toBe(403)
    expect(JSON.stringify(await denied.json())).not.toContain("private")
    expect(calls).toBe(2)
  })

  test("rejects oversized credential requests before parsing them", async () => {
    const response = await app().request("/api/meetings/acs/token", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${await runtimeToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({teamsUserAadToken: "x".repeat(17 * 1024)}),
    })

    expect(response.status).toBe(413)
  })

  test("stops reading a chunked credential request at the byte limit", async () => {
    let chunksRead = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead += 1
        controller.enqueue(new Uint8Array(9 * 1024))
        if (chunksRead === 100) controller.close()
      },
    })
    const request = new Request("https://runtime.test/api/meetings/acs/token", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${await runtimeToken()}`,
        "content-type": "application/json",
      },
      body,
    })

    const response = await app().fetch(request)

    expect(response.status).toBe(413)
    expect(chunksRead).toBeLessThan(100)
  })
})

function app(): Hono {
  const app = new Hono()
  app.route("/api/meetings", meetingsApi)
  return app
}

function runtimeToken(subject = "user-1"): Promise<string> {
  return signRuntimeToken({
    privateKey,
    issuer: ISSUER,
    subject,
    tenantId: "tenant-1",
    sessionId: "session-1",
    expiresInSeconds: 300,
  })
}

function stripPem(value: string): string {
  return value.replace(/-----[^-]+-----/g, "").replace(/\s/g, "")
}

function setEnv(name: string, value: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name])
  process.env[name] = value
}

function deleteEnv(name: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name])
  delete process.env[name]
}
