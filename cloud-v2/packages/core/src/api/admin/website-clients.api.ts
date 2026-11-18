/**
 * @fileoverview The admin portal's miniapp websites (`/api/admin/website-clients`): the websites registered to
 * sign people in with Mentra (`services/oidc/website-clients.service.ts`). Mounted by `admin.api.ts`.
 *
 *   GET    /                    `{clients}`, newest first
 *   POST   /                    registers a website; `{client, secret}`. A server-type client's secret is in
 *                               this answer and nowhere else afterwards
 *   PATCH  /:clientId           changes name, redirect URIs, access or status; `{client}`
 *   POST   /:clientId/secret    replaces a server-type client's secret; `{client, secret}`
 *   DELETE /:clientId           removes the client; 204
 *
 * Listing, changing and removing need `organization.credentials.manage`: an Organization Admin, or an
 * operator key created with it. Registering a website and replacing its secret create a credential, which a
 * key never does, so they need an Organization Admin who is a person (403 for any key).
 *
 * An Organization Admin registers a website for any package, at any HTTPS address, under the name they
 * give, and sees and changes every website, a developer's own included. Every write is in the admin audit
 * log with the admin's email, or the key and the person who created it. A malformed request is `400
 * invalid_request`, an unknown client `404 not_found`.
 */

import {Hono} from "hono"
import {
  createWebsiteClient,
  deleteWebsiteClient,
  listWebsiteClients,
  regenerateWebsiteClientSecret,
  updateWebsiteClient,
} from "../../services/oidc/website-clients.service"
import type {AppContext, AppEnv} from "../../types/hono.types"
import {
  principalLabel,
  requireOrganizationAdminPerson,
  requireOrganizationCapability,
} from "../middleware/principal.middleware"
import {answeringRefusals} from "../website-clients.responses"
import {readJsonObject} from "../workspaces/request"

const app = new Hono<AppEnv>()

/** Reading and changing a website's client: an Organization Admin, or a key that manages credentials. */
const managesCredentials = requireOrganizationCapability("organization.credentials.manage")
/** Making a secret: a person only. */
const personCreatesCredential = requireOrganizationAdminPerson()

const actor = (c: AppContext) => principalLabel(c.get("principal")!)

app.get("/", managesCredentials, async c => {
  c.header("cache-control", "no-store")
  return c.json({clients: await listWebsiteClients()})
})

app.post("/", personCreatesCredential, c =>
  answeringRefusals(c, async () => {
    const body = await readJsonObject(c)
    const created = await createWebsiteClient(
      {
        name: body.name,
        type: body.type,
        environment: body.environment,
        redirectUris: body.redirectUris,
        packageName: body.packageName,
        access: body.access ?? "public",
        accessWorkspaceIds: body.accessWorkspaceIds,
      },
      actor(c),
    )
    // The secret is shown once.
    c.header("cache-control", "no-store")
    return c.json(created, 201)
  }),
)

app.patch("/:clientId", managesCredentials, c =>
  answeringRefusals(c, async () => {
    const body = await readJsonObject(c)
    const client = await updateWebsiteClient(
      c.req.param("clientId"),
      {
        name: body.name,
        redirectUris: body.redirectUris,
        access: body.access,
        accessWorkspaceIds: body.accessWorkspaceIds,
        status: body.status,
      },
      actor(c),
    )
    return c.json({client})
  }),
)

app.post("/:clientId/secret", personCreatesCredential, c =>
  answeringRefusals(c, async () => {
    const regenerated = await regenerateWebsiteClientSecret(c.req.param("clientId"), actor(c))
    c.header("cache-control", "no-store")
    return c.json(regenerated)
  }),
)

app.delete("/:clientId", managesCredentials, c =>
  answeringRefusals(c, async () => {
    await deleteWebsiteClient(c.req.param("clientId"), actor(c))
    return c.body(null, 204)
  }),
)

export default app
