/**
 * @fileoverview A fake Core for the CLI's tests: its `/api/cli/config` and the
 * part of its workspace API the CLI uses (`GET` and `POST /api/workspaces`).
 * It accepts the fake issuer's access tokens as bearers, as Core accepts its
 * own sign-in server's. Every request is recorded with its bearer.
 */

import type {FakeOidcIssuer} from "./fake-oidc-issuer"

export interface RecordedRequest {
  method: string
  path: string
  authorization: string | null
}

export interface FakeService {
  url: string
  requests: RecordedRequest[]
  stop(): void
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? ""
  return header.startsWith("Bearer ") ? header.slice(7) : null
}

export function startFakeCore(options: {
  idp: FakeOidcIssuer
  clientId?: string
  workspaces?: Array<{workspaceId: string; name: string}>
}): FakeService {
  const workspaces = options.workspaces ?? [{workspaceId: "ws_1", name: "Team One"}]
  const summary = (workspace: {workspaceId: string; name: string}) => ({
    ...workspace,
    status: "active",
    authorizationRevision: 1,
    membership: {membershipId: `mem_${workspace.workspaceId}`, role: "owner"},
    capabilities: [],
  })
  const requests: RecordedRequest[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    async fetch(request) {
      const path = new URL(request.url).pathname
      requests.push({method: request.method, path, authorization: request.headers.get("authorization")})
      if (path === "/api/cli/config") {
        return Response.json({issuer: options.idp.issuer, clientId: options.clientId ?? "mentra-cli"})
      }
      const token = bearer(request)
      if (!token || !options.idp.accessTokenOwner(token)) return Response.json({error: "unauthorized"}, {status: 401})
      if (path === "/api/workspaces" && request.method === "GET") return Response.json({items: workspaces.map(summary)})
      if (path === "/api/workspaces" && request.method === "POST") {
        const {name} = (await request.json()) as {name: string}
        const created = {workspaceId: "ws_new", name}
        workspaces.push(created)
        return Response.json(summary(created), {status: 201})
      }
      return Response.json({error: "not_found"}, {status: 404})
    },
  })
  return {url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true)}
}
