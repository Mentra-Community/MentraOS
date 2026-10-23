/**
 * @fileoverview The admin portal's license list (`GET /api/admin/licenses?query=&cursor=`): every license,
 * newest first, 50 to a page, with the workspace that holds it. Mounted inside `/api/admin` by
 * `admin.api.ts` behind `organization.licenses.read`, which only an Organization Admin holds: an operator key
 * never does. It reads what billing wrote and has no route that changes a license or a seat.
 */

import {Hono} from "hono"
import {z} from "zod"
import {
  LICENSE_CURSOR_MAX_LENGTH,
  LICENSE_QUERY_MAX_LENGTH,
  listAllLicenses,
} from "../../services/licenses/license-list.service"
import type {AppEnv} from "../../types/hono.types"
import {InvalidRequest} from "../../types/oauth.types"

const listQuerySchema = z.object({
  query: z.string().max(LICENSE_QUERY_MAX_LENGTH).optional(),
  cursor: z.string().max(LICENSE_CURSOR_MAX_LENGTH).optional(),
})

const app = new Hono<AppEnv>()

app.get("/", async c => {
  const parsed = listQuerySchema.safeParse({query: c.req.query("query"), cursor: c.req.query("cursor")})
  if (!parsed.success) {
    throw new InvalidRequest(
      `query is at most ${LICENSE_QUERY_MAX_LENGTH} characters and cursor at most ${LICENSE_CURSOR_MAX_LENGTH}`,
    )
  }
  return c.json(await listAllLicenses({query: parsed.data.query, cursor: parsed.data.cursor || undefined}))
})

export default app
