/**
 * @fileoverview A fake Mentra Miniapp Store and a fake Core (without a
 * Store) for the CLI's tests. Both accept the fake issuer's access tokens as
 * bearers, as the Store and Core accept Core's, and `msk_` keys listed as
 * workspace keys. Every request is recorded with its bearer and workspace.
 */

import type {FakeOidcIssuer} from "./fake-oidc-issuer"

export interface RecordedRequest {
  method: string
  path: string
  authorization: string | null
  workspaceId: string | null
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

function serve(handle: (request: Request, path: string, record: RecordedRequest) => Response): FakeService {
  const requests: RecordedRequest[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    fetch(request) {
      const path = new URL(request.url).pathname
      const record = {
        method: request.method,
        path,
        authorization: request.headers.get("authorization"),
        workspaceId: request.headers.get("x-mentra-workspace-id"),
      }
      requests.push(record)
      return handle(request, path, record)
    },
  })
  return {url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true)}
}

/** Who a bearer is: a signed-in person (through the issuer) or a workspace key. */
function caller(idp: FakeOidcIssuer, workspaceKeys: string[], request: Request): {id: string; email: string | null} | null {
  const token = bearer(request)
  if (!token) return null
  if (workspaceKeys.includes(token)) return {id: `key:${token}`, email: null}
  const person = idp.accessTokenOwner(token)
  return person ? {id: person.sub, email: person.email ?? null} : null
}

export function startFakeStore(options: {
  idp: FakeOidcIssuer
  clientId?: string
  /** The email the Store reports for a person; the default is the ID token's. */
  storeEmail?: string
  workspaces?: Array<{workspaceId: string; name: string}>
  activeWorkspaceId?: string | null
  workspaceKeys?: string[]
}): FakeService {
  const workspaces = options.workspaces ?? [{workspaceId: "ws_1", name: "Team One"}]
  const summary = (workspace: {workspaceId: string; name: string}) => ({
    ...workspace,
    status: "active",
    authorizationRevision: 1,
    membership: {membershipId: `mem_${workspace.workspaceId}`, role: "owner"},
    capabilities: [],
  })
  return serve((request, path, record) => {
    if (path === "/api/console/auth/cli-config") {
      return Response.json({issuer: options.idp.issuer, clientId: options.clientId ?? "mentra-cli"})
    }
    const who = caller(options.idp, options.workspaceKeys ?? [], request)
    if (!who) return Response.json({error: "unauthorized"}, {status: 401})
    if (path === "/api/console/auth/me") {
      return Response.json({
        user: {id: who.id, email: options.storeEmail ?? who.email},
        workspaces: workspaces.map(summary),
        activeWorkspaceId:
          options.activeWorkspaceId !== undefined
            ? options.activeWorkspaceId
            : workspaces.find(workspace => workspace.workspaceId === record.workspaceId)?.workspaceId ?? null,
      })
    }
    if (path === "/api/console/publishing-profile") {
      if (!record.workspaceId) return Response.json({error: "workspace_selection_required"}, {status: 409})
      return Response.json({workspaceId: record.workspaceId, packagePrefix: "com.example", packagePrefixStatus: "verified"})
    }
    if (path === "/api/admin/me") {
      return Response.json({authenticated: true, admin: true, user: {developerId: who.id, email: who.email}})
    }
    return Response.json({error: "unexpected_request"}, {status: 500})
  })
}

export function startFakeCore(options: {idp: FakeOidcIssuer; clientId?: string; capabilities?: string[]}): FakeService {
  return serve((request, path) => {
    if (path === "/api/cli/config") {
      return Response.json({issuer: options.idp.issuer, clientId: options.clientId ?? "mentra-cli"})
    }
    const who = caller(options.idp, [], request)
    if (!who) return Response.json({error: "unauthorized"}, {status: 401})
    if (path === "/api/admin/me") {
      return Response.json({
        authenticated: true,
        user: {mentraUserId: who.id, email: who.email, emailVerified: true, isOrganizationAdmin: true},
        credential: null,
        organization: {capabilities: options.capabilities ?? []},
        workspaces: [],
      })
    }
    return Response.json({error: "not_found"}, {status: 404})
  })
}
